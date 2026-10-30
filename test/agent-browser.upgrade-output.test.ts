import { hasErrorCode, readArray, readRecord, readString } from "./helpers/assertions.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionPageState } from "../extensions/agent-browser/lib/session-page-state.js";

import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

const upgradeText = "Detected installation via npm.\n✓ Done!";

function upgradeArgs(mode: string): string[] {
	switch (mode) {
		case "ordinary-json":
			return ["snapshot", "-i"];
		case "unsupported-upgrade-shape":
			return ["upgrade", "future"];
		case "nonzero-text":
			return ["--json", "false", "upgrade"];
		case "nonzero-json":
		case "structured-error":
			return ["--json", "upgrade"];
		default:
			return ["upgrade"];
	}
}

function upgradeFailureCategory(mode: string): string {
	switch (mode) {
		case "timeout":
			return "timeout";
		case "abort":
			return "aborted";
		case "missing-binary":
			return "missing-binary";
		case "ordinary-json":
		case "unsupported-upgrade-shape":
			return "parse-failure";
		default:
			return "upstream-error";
	}
}

async function waitForUpgradeSignalHandler(
	marker: string,
	realSetTimeout: (callback: () => void, ms: number) => unknown,
): Promise<void> {
	const deadline = Date.now() + 5000;
	while (true) {
		try {
			// Read after each delay: the child publishes this marker only once its handler is installed.
			// oxlint-disable-next-line no-await-in-loop
			await readFile(marker);
			return;
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) {
				throw error;
			}
		}
		assert.ok(
			Date.now() < deadline,
			"the controlled upgrade child must install its signal handler before timeout or abort",
		);
		// Polling must wait between dependent marker reads, not queue all retries concurrently.
		// oxlint-disable-next-line no-await-in-loop
		await new Promise<void>((resolve) => {
			realSetTimeout(resolve, 5);
		});
	}
}

async function assertUpgradeFailureLogs(mode: string, result: unknown): Promise<void> {
	const details = readRecord(readRecord(result).details);
	const content = readArray(readRecord(result).content);
	if (mode.startsWith("nonzero")) {
		assert.equal(details.exitCode, 7);
		assert.equal(details.parseError, undefined);
		assert.match(readString(details.data), /Detected installation via npm/);
		if (mode === "nonzero-text") {
			assert.equal(
				JSON.stringify(content).split("Detected installation via npm").length - 1,
				1,
				"explicit text stdout is rendered only once",
			);
		}
		if (mode === "nonzero-json") {
			const json = readRecord(JSON.parse(readString(readRecord(content[0]).text)));
			assert.equal(json.success, false);
			assert.match(readString(json.error), /Native upgrade failed/);
			assert.match(readString(json.data), /Detected installation via npm/);
		} else {
			assert.match(
				JSON.stringify(content),
				/Native upgrade failed[\s\S]*Detected installation via npm/,
			);
		}
	}
	if (mode === "large-nonzero") {
		assert.equal(readRecord(details.data).compacted, true);
		assert.ok(
			JSON.stringify(content).length < 8000,
			"failed upgrade logs must use the existing bounded presentation",
		);
		const spill = await readFile(readString(details.fullOutputPath), "utf8");
		assert.match(spill, /Detected installation via npm/);
		assert.equal(spill.split("npm install progress").length - 1, 2000);
		assert.doesNotMatch(spill, /upgrade-secret/);
	}
}

async function assertUpgradeTermination(
	mode: string,
	result: unknown,
	marker: string,
	logPath: string,
): Promise<void> {
	const details = readRecord(readRecord(result).details);
	if (mode === "timeout" || mode === "abort") {
		// POSIX runs the handler; Windows taskkill forcibly closes the shell with 1.
		assert.equal(
			details.exitCode,
			process.platform === "win32" ? 1 : 0,
			"native termination status must retain cancellation/timeout failure",
		);
		assert.equal(details.parseError, undefined);
		if (mode === "timeout") {
			assert.equal(details.timedOut, true);
		}
		const pid = Number(await readFile(marker, "utf8"));
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
		assert.deepEqual(
			(await readInvocationLog(logPath)).map((row) => row.args),
			[["--json", "upgrade"]],
		);
	}
	if (mode === "missing-binary") {
		assert.equal(details.agentBrowserStarted, false);
		assert.deepEqual(await readInvocationLog(logPath), []);
	}
}

test(
	"registered upgrade leaves an existing managed page and refs intact",
	{ concurrency: false },
	async () => {
		const root = await mkdtemp(join(tmpdir(), "up-"));
		const logPath = join(root, "calls.jsonl");
		const url = "https://example.test/current";
		await writeFakeAgentBrowserBinary(
			root,
			`const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + '\\n');
if (args.includes('upgrade')) process.stdout.write(${JSON.stringify(upgradeText)});
else if (args.includes('snapshot')) process.stdout.write(JSON.stringify({ success: true, data: { origin: ${JSON.stringify(url)}, snapshot: '- textbox "Name" [ref=e1]', refs: { e1: { role: 'textbox', name: 'Name' } } } }));
else process.stdout.write(JSON.stringify({ success: true, data: { url: ${JSON.stringify(url)}, title: 'Current page', value: 'Name' } }));`,
		);
		try {
			await withPatchedEnv({ PATH: `${root}:${process.env.PATH ?? ""}` }, async () => {
				const harness = createExtensionHarness({ cwd: root });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				try {
					const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", url],
					});
					const openedDetails = readRecord(opened.details);
					assert.equal(opened.isError, false, opened.content[0].text);
					const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					const snapshotDetails = readRecord(snapshot.details);
					assert.equal(snapshot.isError, false, snapshot.content[0].text);
					const upgrade = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["upgrade"],
						sessionMode: "fresh",
					});
					const upgradeDetails = readRecord(upgrade.details);
					assert.equal(upgrade.isError, false, upgrade.content[0].text);
					assert.equal(upgradeDetails.sessionName, undefined);
					const read = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["get", "value", "@e1"],
					});
					const readDetails = readRecord(read.details);
					assert.equal(read.isError, false, read.content[0].text);
					assert.equal(readDetails.sessionName, openedDetails.sessionName);
					assert.equal(readDetails.refSnapshot, undefined);
					assert.deepEqual(
						SessionPageState.fromBranch(harness.ctx.sessionManager.getBranch()).get(
							readString(readDetails.sessionName),
						).refSnapshot,
						snapshotDetails.refSnapshot,
					);
					assert.deepEqual(readRecord(readDetails.sessionTabTarget).url, url);
					assert.deepEqual(
						(await readInvocationLog(logPath))
							.filter((row) => readArray(row.args).map(readString).includes("upgrade"))
							.map((row) => row.args),
						[["--json", "upgrade"]],
					);
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
	},
);

for (const mode of [
	"nonzero",
	"nonzero-json",
	"nonzero-text",
	"large-nonzero",
	"structured-error",
	"timeout",
	"abort",
	"missing-binary",
	"ordinary-json",
	"unsupported-upgrade-shape",
] as const) {
	test(
		`registered upgrade output keeps failure precedence: ${mode}`,
		{ concurrency: false },
		async (t) => {
			const root = await mkdtemp(join(tmpdir(), "up-"));
			const marker = join(root, "started");
			const logPath = join(root, "calls.jsonl");
			const text =
				"Detected installation via npm.\nDone! Authorization: Bearer upgrade-secret" +
				(mode === "large-nonzero" ? "\nnpm install progress".repeat(2000) : "");
			const binary = await writeFakeAgentBrowserBinary(
				root,
				`const fs = require('node:fs');
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
}`,
			);
			try {
				await withPatchedEnv(
					{
						PATH: mode === "missing-binary" ? root : `${root}:${process.env.PATH ?? ""}`,
						PI_AGENT_BROWSER_TEST_PAGE_URL: "https://fixture.test/",
					},
					async () => {
						if (mode === "missing-binary") {
							await rm(binary);
						}
						const harness = createExtensionHarness({ cwd: root });
						const controller = new AbortController();
						const args = upgradeArgs(mode);
						const realSetTimeout = setTimeout;
						if (mode === "timeout") {
							t.mock.timers.enable({ apis: ["setTimeout"] });
						}
						const pending = executeRegisteredTool(
							harness.tool,
							harness.ctx,
							{ args, ...(mode === "timeout" ? { timeoutMs: 500 } : {}) },
							controller.signal,
						);
						try {
							if (mode === "abort" || mode === "timeout") {
								await waitForUpgradeSignalHandler(marker, realSetTimeout);
								if (mode === "timeout") {
									t.mock.timers.tick(500);
								} else {
									controller.abort();
								}
							}
							const result = await pending;
							const resultDetails = readRecord(result.details);
							assert.equal(result.isError, true);
							assert.equal(resultDetails.resultCategory, "failure");
							const expectedCategory = upgradeFailureCategory(mode);
							assert.equal(resultDetails.failureCategory, expectedCategory, result.content[0].text);
							assert.doesNotMatch(JSON.stringify(result), /upgrade-secret|stderr-secret/);
							await assertUpgradeFailureLogs(mode, result);
							await assertUpgradeTermination(mode, result, marker, logPath);
						} finally {
							if (mode === "timeout") {
								t.mock.timers.reset();
							}
							controller.abort();
							await Promise.allSettled([pending]);
						}
					},
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
}

for (const args of [
	["upgrade"],
	["--json", "upgrade"],
	["--namespace", "up", "--session", "caller", "upgrade"],
]) {
	test(
		`registered upgrade preserves successful text without inspection semantics: ${args.join(" ")}`,
		{ concurrency: false },
		async () => {
			const root = await mkdtemp(join(tmpdir(), "up-"));
			const logPath = join(root, "calls.jsonl");
			await writeFakeAgentBrowserBinary(
				root,
				`const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2) }) + '\\n');
process.stdout.write(${JSON.stringify(` \n${upgradeText}\n\n`)});`,
			);
			try {
				await withPatchedEnv({ PATH: `${root}:${process.env.PATH ?? ""}` }, async () => {
					const harness = createExtensionHarness({ cwd: root });
					const outputPath = args.includes("--json") ? join(root, "upgrade.txt") : undefined;
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args,
						outputPath,
					});
					const resultDetails = readRecord(result.details);
					assert.equal(result.isError, false, result.content[0].text);
					assert.equal(resultDetails.resultCategory, "success");
					assert.equal(resultDetails.successCategory, "completed");
					assert.equal(resultDetails.inspection, undefined);
					assert.equal(resultDetails.parseError, undefined);
					assert.equal(resultDetails.managedSessionOutcome, undefined);
					assert.equal(resultDetails.data, upgradeText);
					const metadata = {
						success: true,
						resultCategory: "success",
						successCategory: "completed",
						...(args.includes("--session") ? { sessionName: "caller", namespace: "up" } : {}),
					};
					if (args.includes("--json")) {
						// Exhaustive fixture variant (args.includes("--json")): this selected path must satisfy its own contract.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.deepEqual(readRecord(JSON.parse(result.content[0].text ?? "")), {
							...metadata,
							data: upgradeText,
							summary: "Detected installation via npm.",
							outputFile: resultDetails.outputFile,
						});
					} else {
						// Exhaustive fixture variant (args.includes("--json")): this selected path must satisfy its own contract.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							result.content[0].text,
							`${upgradeText}\n\nObservation: ${JSON.stringify(metadata)}`,
						);
					}
					if (outputPath !== undefined) {
						// Exhaustive fixture variant (outputPath !== undefined): this selected path must satisfy its own contract.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(await readFile(outputPath, "utf8"), upgradeText);
					}
					assert.deepEqual(
						(await readInvocationLog(logPath)).map((row) => row.args),
						[args.includes("--json") ? args : ["--json", ...args]],
					);
				});
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);
}
