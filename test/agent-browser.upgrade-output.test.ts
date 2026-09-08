import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

const upgradeText = "Detected installation via npm.\n✓ Done!";

test("registered upgrade leaves an existing managed page and refs intact", { concurrency: false }, async () => {
	const root = await mkdtemp(join(tmpdir(), "up-"));
	const logPath = join(root, "calls.jsonl");
	const url = "https://example.test/current";
	await writeFakeAgentBrowserBinary(root, `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + '\\n');
if (args.includes('upgrade')) process.stdout.write(${JSON.stringify(upgradeText)});
else if (args.includes('snapshot')) process.stdout.write(JSON.stringify({ success: true, data: { origin: ${JSON.stringify(url)}, snapshot: '- textbox "Name" [ref=e1]', refs: { e1: { role: 'textbox', name: 'Name' } } } }));
else process.stdout.write(JSON.stringify({ success: true, data: { url: ${JSON.stringify(url)}, title: 'Current page', value: 'Name' } }));`);
	try {
		await withPatchedEnv({ PATH: `${root}:${process.env.PATH ?? ""}` }, async () => {
			const harness = createExtensionHarness({ cwd: root });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			try {
				const opened = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", url] });
				assert.equal(opened.isError, false, opened.content[0]?.text);
				const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
				assert.equal(snapshot.isError, false, snapshot.content[0]?.text);
				const upgrade = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["upgrade"], sessionMode: "fresh" });
				assert.equal(upgrade.isError, false, upgrade.content[0]?.text);
				assert.equal(upgrade.details?.sessionName, undefined);
				const read = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "value", "@e1"] });
				assert.equal(read.isError, false, read.content[0]?.text);
				assert.equal(read.details?.sessionName, opened.details?.sessionName);
				assert.deepEqual(read.details?.refSnapshot, snapshot.details?.refSnapshot);
				assert.deepEqual((read.details?.sessionTabTarget as { url: string }).url, url);
				assert.deepEqual((await readInvocationLog(logPath)).filter((row) => row.args.includes("upgrade")).map((row) => row.args), [["--json", "upgrade"]]);
			} finally { await runExtensionEvent(harness.handlers, "session_shutdown", { reason: "quit" }, harness.ctx); }
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});


for (const mode of ["nonzero", "nonzero-json", "large-nonzero", "structured-error", "timeout", "abort", "missing-binary", "ordinary-json", "unsupported-upgrade-shape"] as const) {
	test(`registered upgrade output keeps failure precedence: ${mode}`, { concurrency: false }, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "up-"));
		const marker = join(root, "started");
		const logPath = join(root, "calls.jsonl");
		const text = "Detected installation via npm.\nDone! Authorization: Bearer upgrade-secret" + (mode === "large-nonzero" ? "\nnpm install progress".repeat(2000) : "");
		const binary = await writeFakeAgentBrowserBinary(root, `const fs = require('node:fs');
const mode = ${JSON.stringify(mode)};
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2) }) + '\\n');
if (mode === 'structured-error') {
  process.stdout.write(JSON.stringify({ success: false, error: 'Native upgrade failed.' }));
} else {
  process.stdout.write(${JSON.stringify(text)});
  if (mode.includes('nonzero')) { process.stderr.write('Native upgrade failed. Authorization: Bearer stderr-secret'); process.exitCode = 7; }
  if (mode === 'abort' || mode === 'timeout') {
    process.on('SIGTERM', () => process.exit(0));
    fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
    setInterval(() => {}, 1000);
  }
}`);
		try {
			await withPatchedEnv({ PATH: mode === "missing-binary" ? root : `${root}:${process.env.PATH ?? ""}` }, async () => {
				if (mode === "missing-binary") await rm(binary);
				const harness = createExtensionHarness({ cwd: root });
				const controller = new AbortController();
				const args = mode === "ordinary-json" ? ["snapshot", "-i"] : mode === "unsupported-upgrade-shape" ? ["upgrade", "future"] : mode === "nonzero-json" || mode === "structured-error" ? ["--json", "upgrade"] : ["upgrade"];
				const realSetTimeout = setTimeout;
				if (mode === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
				const pending = executeRegisteredTool(harness.tool, harness.ctx, { args, ...(mode === "timeout" ? { timeoutMs: 500 } : {}) }, controller.signal);
				try {
					if (mode === "abort" || mode === "timeout") {
						const deadline = Date.now() + 5000;
						while (true) {
							try { await readFile(marker); break; }
							catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
							assert.ok(Date.now() < deadline, "the controlled upgrade child must install its signal handler before timeout or abort");
							await new Promise((resolve) => realSetTimeout(resolve, 5));
						}
						if (mode === "timeout") t.mock.timers.tick(500);
						else controller.abort();
					}
					const result = await pending;
					assert.equal(result.isError, true);
					assert.equal(result.details?.resultCategory, "failure");
					const expectedCategory = mode === "timeout" ? "timeout" : mode === "abort" ? "aborted" : mode === "missing-binary" ? "missing-binary" : mode === "ordinary-json" || mode === "unsupported-upgrade-shape" ? "parse-failure" : "upstream-error";
					assert.equal(result.details?.failureCategory, expectedCategory, result.content[0]?.text);
					assert.doesNotMatch(JSON.stringify(result), /upgrade-secret|stderr-secret/);
					if (mode.startsWith("nonzero")) {
						assert.equal(result.details?.exitCode, 7);
						assert.equal(result.details?.parseError, undefined);
						assert.match(String(result.details?.data), /Detected installation via npm/);
						if (mode === "nonzero-json") {
							const json = JSON.parse(result.content[0]?.text ?? "");
							assert.equal(json.success, false);
							assert.match(json.error, /Native upgrade failed/);
							assert.match(json.data, /Detected installation via npm/);
						} else assert.match(JSON.stringify(result.content), /Native upgrade failed[\s\S]*Detected installation via npm/);
					}
					if (mode === "large-nonzero") {
						assert.equal((result.details?.data as { compacted?: boolean }).compacted, true);
						assert.ok(JSON.stringify(result.content).length < 8000, "failed upgrade logs must use the existing bounded presentation");
						const spill = await readFile(String(result.details?.fullOutputPath), "utf8");
						assert.match(spill, /Detected installation via npm/);
						assert.equal(spill.split("npm install progress").length - 1, 2000);
						assert.doesNotMatch(spill, /upgrade-secret/);
					}
					if (mode === "timeout" || mode === "abort") {
						assert.equal(result.details?.exitCode, 0, "even a clean signal-handler exit must retain cancellation/timeout failure");
						assert.equal(result.details?.parseError, undefined);
						if (mode === "timeout") assert.equal(result.details?.timedOut, true);
						const pid = Number(await readFile(marker, "utf8"));
						assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
						assert.deepEqual((await readInvocationLog(logPath)).map((row) => row.args), [["--json", "upgrade"]]);
					}
					if (mode === "missing-binary") {
						assert.equal(result.details?.agentBrowserStarted, false);
						assert.deepEqual(await readInvocationLog(logPath), []);
					}
				} finally {
					if (mode === "timeout") t.mock.timers.reset();
					controller.abort();
					await Promise.allSettled([pending]);
				}
			});
		} finally { await rm(root, { recursive: true, force: true }); }
	});
}


for (const args of [["upgrade"], ["--json", "upgrade"], ["--namespace", "up", "--session", "caller", "upgrade"]]) {
	test(`registered upgrade preserves successful text without inspection semantics: ${args.join(" ")}`, { concurrency: false }, async () => {
		const root = await mkdtemp(join(tmpdir(), "up-"));
		const logPath = join(root, "calls.jsonl");
		await writeFakeAgentBrowserBinary(root, `const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2) }) + '\\n');
process.stdout.write(${JSON.stringify(` \n${upgradeText}\n\n`)});`);
		try {
			await withPatchedEnv({ PATH: `${root}:${process.env.PATH ?? ""}` }, async () => {
				const harness = createExtensionHarness({ cwd: root });
				const outputPath = args.includes("--json") ? join(root, "upgrade.txt") : undefined;
				const result = await executeRegisteredTool(harness.tool, harness.ctx, { args, outputPath });
				assert.equal(result.isError, false, result.content[0]?.text);
				assert.equal(result.details?.resultCategory, "success");
				assert.equal(result.details?.successCategory, "completed");
				assert.equal(result.details?.inspection, undefined);
				assert.equal(result.details?.parseError, undefined);
				assert.equal(result.details?.managedSessionOutcome, undefined);
				assert.equal(result.details?.data, upgradeText);
				if (args.includes("--json")) assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), { success: true, data: upgradeText });
				else assert.equal(result.content[0]?.text, upgradeText);
				if (outputPath) assert.equal(await readFile(outputPath, "utf8"), upgradeText);
				assert.deepEqual((await readInvocationLog(logPath)).map((row) => row.args), [args.includes("--json") ? args : ["--json", ...args]]);
			});
		} finally { await rm(root, { recursive: true, force: true }); }
	});
}
