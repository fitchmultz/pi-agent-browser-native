import { hasErrorCode, readArray, readRecord, readString } from "./helpers/assertions.js";
import assert from "node:assert/strict";
import { getMessageText } from "../extensions/agent-browser/lib/prompt-policy.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";
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
		await new Promise<void>((resolve) => {
			realSetTimeout(resolve, 5);
		});
	}
}

nodeTest(
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
					assert.equal(opened.isError, false, getMessageText(opened.content));
					const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					const snapshotDetails = readRecord(snapshot.details);
					assert.equal(snapshot.isError, false, getMessageText(snapshot.content));
					const upgrade = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["upgrade"],
						sessionMode: "fresh",
					});
					const upgradeDetails = readRecord(upgrade.details);
					assert.equal(upgrade.isError, false, getMessageText(upgrade.content));
					assert.equal(upgradeDetails.sessionName, undefined);
					const read = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["get", "value", "@e1"],
					});
					const readDetails = readRecord(read.details);
					assert.equal(read.isError, false, getMessageText(read.content));
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
	nodeTest(
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
							assert.equal(
								resultDetails.failureCategory,
								expectedCategory,
								getMessageText(result.content),
							);
							assert.doesNotMatch(JSON.stringify(result), /upgrade-secret|stderr-secret/);
							if (mode.startsWith("nonzero")) {
								await t.test("retains failed upgrade output", async (logs) => {
									assert.equal(resultDetails.exitCode, 7);
									assert.equal(resultDetails.parseError, undefined);
									assert.match(readString(resultDetails.data), /Detected installation via npm/);
									if (mode === "nonzero-text") {
										await logs.test("renders stdout once", () => {
											assert.equal(
												JSON.stringify(result.content).split("Detected installation via npm")
													.length - 1,
												1,
											);
										});
									}
									if (mode === "nonzero-json") {
										await logs.test("preserves the failed JSON envelope", () => {
											const json = readRecord(JSON.parse(getMessageText(result.content)));
											assert.equal(json.success, false);
											assert.match(readString(json.error), /Native upgrade failed/);
											assert.match(readString(json.data), /Detected installation via npm/);
										});
									} else {
										await logs.test("renders the native failure with stdout", () => {
											assert.match(
												JSON.stringify(result.content),
												/Native upgrade failed[\s\S]*Detected installation via npm/,
											);
										});
									}
								});
							}
							if (mode === "large-nonzero") {
								await t.test("bounds and redacts large failed upgrade logs", async () => {
									assert.equal(readRecord(resultDetails.data).compacted, true);
									assert.ok(JSON.stringify(result.content).length < 8000);
									const spill = await readFile(readString(resultDetails.fullOutputPath), "utf8");
									assert.match(spill, /Detected installation via npm/);
									assert.equal(spill.split("npm install progress").length - 1, 2000);
									assert.doesNotMatch(spill, /upgrade-secret/);
								});
							}
							if (mode === "timeout" || mode === "abort") {
								await t.test("reaps the terminated native child", async (termination) => {
									assert.equal(
										resultDetails.exitCode,
										process.platform === "win32" ? 1 : 0,
										"native termination status must retain cancellation/timeout failure",
									);
									assert.equal(resultDetails.parseError, undefined);
									if (mode === "timeout") {
										await termination.test("reports timeout", () => {
											assert.equal(resultDetails.timedOut, true);
										});
									}
									const pid = Number(await readFile(marker, "utf8"));
									assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
									assert.deepEqual(
										(await readInvocationLog(logPath)).map((row) => row.args),
										[["--json", "upgrade"]],
									);
								});
							}
							if (mode === "missing-binary") {
								await t.test("never starts the missing binary", async () => {
									assert.equal(resultDetails.agentBrowserStarted, false);
									assert.deepEqual(await readInvocationLog(logPath), []);
								});
							}
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
	nodeTest(
		`registered upgrade preserves successful text without inspection semantics: ${args.join(" ")}`,
		{ concurrency: false },
		async (t) => {
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
					assert.equal(result.isError, false, getMessageText(result.content));
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
						await t.test("renders the successful JSON envelope", () => {
							assert.deepEqual(readRecord(JSON.parse(getMessageText(result.content))), {
								...metadata,
								data: upgradeText,
								summary: "Detected installation via npm.",
								outputFile: resultDetails.outputFile,
							});
						});
					} else {
						await t.test("renders native text with observation metadata", () => {
							assert.equal(
								getMessageText(result.content),
								`${upgradeText}\n\nObservation: ${JSON.stringify(metadata)}`,
							);
						});
					}
					if (outputPath !== undefined) {
						await t.test("exports the complete native text", async () => {
							assert.equal(await readFile(outputPath, "utf8"), upgradeText);
						});
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
