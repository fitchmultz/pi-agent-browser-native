import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { TARGET_AGENT_BROWSER_VERSION_LABEL } from "../scripts/agent-browser-target.mjs";

import { validateAgentBrowserScriptBrowserParams } from "../extensions/agent-browser/lib/input-modes/script.js";
import { validateToolArgs } from "../extensions/agent-browser/lib/runtime.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";
import { readRecord, readArray } from "./helpers/assertions.js";

const url = "https://chromium-args.example.test/";

async function withFixture(
	run: (
		root: string,
		harness: Pick<ReturnType<typeof createExtensionHarness>, "tool" | "ctx">,
		log: string,
	) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "ca-"));
	const log = join(root, "calls.jsonl");
	await writeFakeAgentBrowserBinary(
		root,
		`const fs = require('node:fs');
const args = process.argv.slice(2), stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin }) + '\\n');
if (args.includes('--version')) { process.stdout.write(${JSON.stringify(`${TARGET_AGENT_BROWSER_VERSION_LABEL}\n`)}); process.exit(0); }
if (args.includes('--help')) { process.stdout.write('Native fixture help'); process.exit(0); }
const tokens = [];
for (let i = 0; i < args.length; i++) {
  if (['--session', '--namespace', '--args', '--user-agent', '--headers'].includes(args[i])) i++;
  else if (args[i] !== '--json') tokens.push(args[i]);
}
const data = row => ({ url: ${JSON.stringify(url)}, title: 'Literal fixture', echo: row });
if (tokens[0] === 'batch') {
  const raw = tokens.slice(1).filter(token => token !== '--bail');
  const rows = raw.length ? JSON.parse(fs.readFileSync(${JSON.stringify(join(root, "raw-rows.json"))}, 'utf8')) : JSON.parse(stdin);
  process.stdout.write(JSON.stringify(rows.map(command => ({ command, success: true, result: data(command) }))));
} else if (tokens[0] === 'eval' && tokens[1] === '--no-sandbox') {
  process.stdout.write(JSON.stringify({ success: false, error: 'Native fixture evaluation error' }));
  process.exitCode = 1;
} else process.stdout.write(JSON.stringify({ success: true, data: data(tokens) }));`,
		"linux",
	); // Intentional shell-free shebang fixture; stock CMD transport has separate native coverage.
	try {
		await withPatchedEnv(
			{
				PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
				PI_AGENT_BROWSER_TEST_CUSTOM_VERSION: "1",
			},
			async () => {
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
			},
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("Chromium diagnostic uses native top-level globals but raw batch tokens", async () => {
	assert.match(validateToolArgs(["goto", "--no-sandbox", url]) ?? "", /ignored.*option/);
	assert.match(validateToolArgs(["navigate", url, "--no-sandbox"]) ?? "", /ignored.*option/);
	assert.match(
		validateToolArgs(["--args", "--disable-gpu", "--no-sandbox", "open", url]) ?? "",
		/not an agent-browser command/,
	);
	assert.equal(validateToolArgs(["open", url, "--args", "--no-sandbox"]), undefined);
	assert.match(
		validateToolArgs(["open", url, "--args", "--no-sandbox"], { batchStep: true }) ?? "",
		/ignored.*option/,
	);
	assert.match(
		validateToolArgs(["--args", "--no-sandbox", "open", url, "--no-sandbox"]) ?? "",
		/ignored.*option/,
	);
	assert.equal(validateToolArgs(["--user-agent", "--no-sandbox", "open", url]), undefined);
	for (const args of [
		["--headers", '{"X-Flag":"--no-sandbox"}', "open", url],
		["fill", "#field", "--no-sandbox"],
		["type", "#field", "before", "--no-sandbox", "after", "--clear", "--delay", "5"],
		["select", "#pick", "--no-sandbox"],
		["find", "role", "button", "click", "--name", "--no-sandbox"],
	]) {
		// Each fixed literal/header input must pass direct recognition independently.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(validateToolArgs(args), undefined, args.join(" "));
	}
	assert.equal(validateToolArgs(["--no-sandbox", "--help"]), undefined);
	assert.equal(validateToolArgs(["--no-sandbox", "--version"]), undefined);
	assert.match(
		validateToolArgs(["--no-sandbox", "--help"], { batchStep: true }) ?? "",
		/not an agent-browser command/,
	);
	assert.match(
		validateToolArgs(["--args=--no-sandbox", "open", url]) ?? "",
		/does not support `--args=<value>`/,
	);
	assert.match(
		validateToolArgs(["open", url, "--args=--no-sandbox"], { batchStep: true }) ?? "",
		/Move `--args` and its value before `batch`/,
	);
	assert.equal(
		validateAgentBrowserScriptBrowserParams({ args: ["fill", "#field", "--no-sandbox"] }).error,
		undefined,
	);
	assert.match(
		validateAgentBrowserScriptBrowserParams({ args: ["open", url, "--no-sandbox"] }).error ?? "",
		/Chromium launch argument/,
	);

	await withFixture(async (_root, harness, log) => {
		async function rejectsBeforeDispatch(
			step: readonly string[],
			mode: "direct" | "stdin" | "raw",
		) {
			const requests = {
				direct: { args: [...step] },
				stdin: { args: ["batch"], stdin: JSON.stringify([step]) },
				raw: { args: ["batch", step.map((value) => JSON.stringify(value)).join(" ")] },
			};
			const result = await executeRegisteredTool(harness.tool, harness.ctx, requests[mode]);
			const context = `${step.join(" ")}/${mode}`;
			assert.equal(result.isError, true, context);
			assert.equal(result.details?.failureCategory, "validation-error", context);
			assert.match(result.content[0].text ?? "", /Chromium launch argument/, context);
			assert.match(result.content[0].text ?? "", /top-level.*--args/, context);
			assert.match(result.content[0].text ?? "", /sessionMode.*fresh/, context);
			assert.match(
				result.content[0].text ?? "",
				step[0] === "--no-sandbox" ? /not an agent-browser command/ : /ignored.*option/,
				context,
			);
			assert.deepEqual(
				await readInvocationLog(log),
				[],
				`${context}: validation must precede even the version subprocess`,
			);
		}
		for (const step of [
			["--no-sandbox", "open", url],
			["open", url, "--no-sandbox"],
			["open", "--no-sandbox"],
		]) {
			for (const mode of ["direct", "stdin", "raw"] as const) {
				// Each rejected request must leave the shared fixture untouched before the next variant.
				// oxlint-disable-next-line no-await-in-loop
				await rejectsBeforeDispatch(step, mode);
			}
		}
	});
});

for (const args of [
	["--args", "--disable-gpu,--no-sandbox", "open", url],
	["open", url, "--args", "--disable-gpu\n--no-sandbox"],
	["upload", "#files", "--no-sandbox"],
	["eval", "--no-sandbox"],
	["--no-sandbox", "--help"],
] as const) {
	test(
		`Chromium diagnostic preserves native argv and outcome: ${args.join(" ")}`,
		{ concurrency: false },
		async () => {
			await withFixture(async (root, harness, log) => {
				await writeFile(join(root, "--no-sandbox"), "upload fixture");
				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [...args],
					sessionMode: "fresh",
				});
				assert.notEqual(
					result.details?.failureCategory,
					"validation-error",
					result.content[0].text,
				);
				const evaluation = args[0] === "eval";
				assert.equal(result.isError, evaluation, result.content[0].text);
				if (evaluation) {
					// This enumerated fixture branch (evaluation) has variant-specific assertions; common assertions cover every case.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.match(result.content[0].text ?? "", /Native fixture evaluation error/);
				}
				const calls = await readInvocationLog(log);
				const expected = args.map((token, index) =>
					args[index - 1] === "--args" ? `--no-startup-window,${token}` : token,
				);
				assert.ok(
					calls.some(
						(call) =>
							JSON.stringify(call.args.slice(-expected.length)) === JSON.stringify(expected),
					),
					JSON.stringify(calls),
				);
			});
		},
	);
}

for (const mode of ["stdin", "raw"] as const) {
	test(
		`Chromium literal data and outer launch args survive an effective ${mode} batch`,
		{ concurrency: false },
		async () => {
			await withFixture(async (root, harness, log) => {
				const rows = [
					["fill", "#field", "--no-sandbox"],
					["fill", "#field", "--args", "--no-sandbox"],
					["select", "#pick", "--no-sandbox"],
					["type", "#field", "before", "--no-sandbox", "after", "--clear", "--delay", "5"],
					["find", "role", "button", "click", "--name", "--no-sandbox"],
				];
				await writeFile(join(root, "raw-rows.json"), JSON.stringify(rows));
				const args = [
					"--args",
					"--no-sandbox",
					"--headers",
					'{"X-Flag":"--no-sandbox"}',
					"batch",
					...(mode === "raw"
						? rows.map((row) => row.map((value) => JSON.stringify(value)).join(" "))
						: []),
				];
				const stdin = JSON.stringify(mode === "raw" ? [["open", url, "--no-sandbox"]] : rows);
				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args,
					stdin,
					sessionMode: "fresh",
				});
				assert.equal(result.isError, false, JSON.stringify(result));
				const batch = (await readInvocationLog(log)).find((call) => call.args.includes("batch"));
				assert.deepEqual(batch?.args.slice(-args.length), [
					"--args",
					"--no-startup-window,--no-sandbox",
					...args.slice(2),
				]);
				assert.equal(readRecord(batch).stdin, stdin);
				assert.deepEqual(
					readArray(result.details?.batchSteps)
						.map(readRecord)
						.map((step) => readRecord(step.data).echo),
					rows,
				);
			});
		},
	);
}
