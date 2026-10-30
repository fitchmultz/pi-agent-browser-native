import { readArray, readBoolean, readRecord, readString } from "./helpers/assertions.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
	GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES,
	GLOBAL_VALUE_FLAGS,
	VALUE_FLAGS,
} from "../extensions/agent-browser/lib/argv-grammar.js";
import { TARGET_AGENT_BROWSER_VERSION } from "../scripts/agent-browser-target.mjs";
import { BROWSER_TRANSITION_ENTRY } from "../extensions/agent-browser/lib/browser-transcript.js";
import {
	getGuardedRefUsage,
	shouldPinSessionTabForCommand,
} from "../extensions/agent-browser/lib/orchestration/browser-run/session-state.js";
import {
	ManagedSessionRestoreState,
	withOwnedManagedSessionContext,
} from "../extensions/agent-browser/lib/managed-session-restore.js";
import { runAgentBrowserProcess } from "../extensions/agent-browser/lib/process.js";
import { waitForTestPidExit } from "./helpers/extension-validation-fixtures.js";

import {
	createExtensionHarness,
	createShortPrivateSocketDir,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	startAgentBrowserContractFixtureServer,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test("global argv flags match the audited upstream grammar baseline", async () => {
	const grammar = readRecord(
		JSON.parse(
			await readFile(
				new URL("./fixtures/agent-browser-argv-grammar.json", import.meta.url),
				"utf8",
			),
		),
	);
	assert.equal(
		grammar.version,
		TARGET_AGENT_BROWSER_VERSION,
		"Re-audit flags.rs clean_args when rebaselining upstream",
	);
	assert.deepEqual(new Set(GLOBAL_VALUE_FLAGS), new Set(readArray(grammar.globalValueFlags)));
	assert.deepEqual(
		GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES,
		new Set(readArray(grammar.globalBooleanFlags)),
	);
	for (const flag of readArray(grammar.globalValueFlags)) {
		// Exhaustive fixture variant (readArray(grammar.globalValueFlags)): this selected path must satisfy its own contract.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(VALUE_FLAGS.has(readString(flag)), true, readString(flag));
	}
});

test("ref guards follow upstream selector slots, not literal operands or key/mouse data", () => {
	for (const ref of ["@e1", "e1", "ref=e1", " ref=e1 "]) {
		for (const args of [
			["fill", ref, "text"],
			...["text", "html", "value", "attr", "box", "styles"].map((getter) => ["get", getter, ref]),
			["drag", "#source", ref],
			["click", "--new-tab", ref],
			["scroll", "down", "--selector", ref],
			["diff", "screenshot", "-s", ref],
		]) {
			// Every ref spelling and selector command is asserted; no matrix variant can silently pass.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.deepEqual(getGuardedRefUsage(args), ["e1"], JSON.stringify(args));
		}
	}
	for (const args of [
		["fill", "#field", "@e1"],
		["type", "#field", "ref=e1"],
		["select", "#field", "e1"],
		["download", "#link", "@e1"],
		["upload", "#field", "@e1"],
		["get", "attr", "#field", "@e1"],
		["press", "@e1"],
		["key", "@e1"],
		["keyboard", "inserttext", "@e1"],
		["mouse", "wheel", "@e1"],
		["screenshot", "#field", "@e1"],
		["diff", "screenshot", "-b", "@e1", "-o", "@e2"],
		["click", "@e1-suffix"],
		["scroll", "@e1"],
		["get", "url", "@e1"],
		["get", "count", "e999"],
		["diff", "snapshot", "--selector", "e999"],
		["diff", "snapshot", "-s", "@e999"],
	]) {
		// Every literal-operand variant is asserted to stay outside selector-ref scanning.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.deepEqual(getGuardedRefUsage(args), [], JSON.stringify(args));
	}
});

test("tab pinning leaves explicit recovery available but still guards content after read-only batch prefixes", () => {
	for (const first of [["tab", "list"], ["tab"], ["session", "info"], ["get", "url"]]) {
		// Exhaustive fixture variant ([["tab", "list"], ["tab"], ["session", "info"], ["get", "url"]]): this selected path must satisfy its own contract.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(
			shouldPinSessionTabForCommand({
				command: "batch",
				commandTokens: ["batch"],
				stdin: JSON.stringify([first, ["fill", "#field", "text"]]),
				pinningRequired: true,
				sessionName: "named",
			}),
			true,
		);
	}
	for (const first of [
		["tab", "t1"],
		["tab", "new", "about:blank"],
		["open", "about:blank"],
		["close"],
		["connect", "9222"],
		["state", "load", "state.json"],
	]) {
		// Every explicit tab/navigation/lifecycle recovery command is asserted to bypass the old pin.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(
			shouldPinSessionTabForCommand({
				command: "batch",
				commandTokens: ["batch"],
				stdin: JSON.stringify([first, ["get", "url"]]),
				pinningRequired: true,
				sessionName: "named",
			}),
			false,
		);
	}
	for (const commandTokens of [
		["get", "url"],
		["skills", "list"],
		[
			"auth",
			"save",
			"fixture",
			"--url",
			"https://example.test/",
			"--username",
			"fixture",
			"--password-stdin",
		],
		["connect", "9222"],
		["state", "load", "state.json"],
	]) {
		// Every non-content prefix variant must leave the later guarded snapshot visible.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(
			shouldPinSessionTabForCommand({
				command: commandTokens[0],
				commandTokens,
				pinningRequired: true,
				sessionName: "named",
			}),
			false,
		);
	}
	for (const commandTokens of [
		["back"],
		["forward"],
		["reload"],
		["click", "#field"],
		["frame", "#child"],
	]) {
		// Exhaustive fixture variant ([ ["back"], ["forward"], ["reload"], ["click", "#field"], ["frame", "#child"], ]): this selected path must satisfy its own contract.
		// oxlint-disable-next-line node-test/no-conditional-assertion
		assert.equal(
			shouldPinSessionTabForCommand({
				command: commandTokens[0],
				commandTokens,
				pinningRequired: true,
				sessionName: "named",
			}),
			true,
		);
	}
});

test("recording FPS options alone keep the intended tab", () => {
	for (const subcommand of ["start", "restart"]) {
		for (const step of [
			["record", subcommand, "capture.webm", "--fps", "30"],
			["record", subcommand, "--fps", "12", "capture.webm", "--fps", "24"],
		]) {
			// Both start/restart and FPS positions are checked for the same path and ref policy.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(
				shouldPinSessionTabForCommand({
					command: "record",
					commandTokens: step,
					pinningRequired: true,
					sessionName: "named",
				}),
				true,
				JSON.stringify(step),
			);
			// Both start/restart and FPS positions are checked for the same path and ref policy.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(
				shouldPinSessionTabForCommand({
					command: "batch",
					commandTokens: ["batch"],
					stdin: JSON.stringify([step]),
					pinningRequired: true,
					sessionName: "named",
				}),
				true,
			);
			// Both start/restart and FPS positions are checked for the same path and ref policy.
			// oxlint-disable-next-line node-test/no-conditional-assertion
			assert.equal(
				shouldPinSessionTabForCommand({
					command: "batch",
					commandTokens: ["batch", step.join(" ")],
					stdin: '[["open","https://ignored.example/"]]',
					pinningRequired: true,
					sessionName: "named",
				}),
				true,
			);
			for (const withUrl of [
				[...step, "https://chosen.example/"],
				["record", subcommand, "capture.webm", "https://chosen.example/", "--fps", "24"],
			]) {
				// Every explicit-URL recording variant is checked to retain its chosen target.
				// oxlint-disable-next-line node-test/no-conditional-assertion
				assert.equal(
					shouldPinSessionTabForCommand({
						command: "record",
						commandTokens: withUrl,
						pinningRequired: true,
						sessionName: "named",
					}),
					false,
				);
			}
		}
	}
});

const real = process.env.PI_AGENT_BROWSER_REAL_UPSTREAM === "1";

test(
	"real upstream indexed batch identity preserves redaction and ordered observations",
	{
		skip: !real,
		timeout: 150_000,
	},
	async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "piab-indexed-batch-"));
		const socketDir = createShortPrivateSocketDir(dir);
		const fixture = await startAgentBrowserContractFixtureServer();
		try {
			await withPatchedEnv(
				{
					HOME: dir,
					USERPROFILE: dir,
					PI_CODING_AGENT_DIR: join(dir, "pi"),
					PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_CONFIG: undefined,
					AGENT_BROWSER_NAMESPACE: undefined,
					AGENT_BROWSER_PROFILE: undefined,
					AGENT_BROWSER_RESTORE: undefined,
					AGENT_BROWSER_CDP: undefined,
					AGENT_BROWSER_AUTO_CONNECT: undefined,
				},
				async () => {
					const h = createExtensionHarness({ cwd: dir });
					const session = `indexed-${randomUUID().slice(0, 8)}`;
					const call = (args: readonly string[], stdin?: string, outputPath?: string) =>
						executeRegisteredTool(h.tool, h.ctx, {
							args: ["--session", session, ...args],
							stdin,
							outputPath,
						});
					const url = `${fixture.baseUrl}/contract`;
					const rows = [
						["storage", "local", "set", "ordinary", "indexed-storage-secret"],
						["storage", "local", "get", "ordinary"],
						["cookies", "set", "ordinary", "indexed-cookie-secret", "--url", fixture.baseUrl],
						["cookies", "get"],
						["get", "url"],
					];
					try {
						assert.equal((await call(["open", url])).isError, false);
						for (const mode of ["command", "indexed-stdin", "indexed-argv"]) {
							// Each input mode uses the same real page and secret-bearing native commands.
							await t.test(mode, async () => {
								const args = ["batch", "--bail", ...(mode === "command" ? [] : ["--omit-command"])];
								const outputPath = join(dir, `${mode}.json`);
								const result = await call(
									mode === "indexed-argv" ? [...args, ...rows.map((row) => row.join(" "))] : args,
									JSON.stringify(
										mode === "indexed-argv" ? [["open", "https://ignored.invalid"]] : [[], ...rows],
									),
									outputPath,
								);
								assert.equal(result.isError, false, JSON.stringify(result));
								assert.doesNotMatch(
									JSON.stringify(result),
									/indexed-cookie-secret|indexed-storage-secret/,
								);
								assert.doesNotMatch(
									await readFile(outputPath, "utf8"),
									/indexed-cookie-secret|indexed-storage-secret/,
								);
								assert.doesNotMatch(
									JSON.stringify(h.appendedEntries),
									/indexed-cookie-secret|indexed-storage-secret/,
								);
								const details = readRecord(result.details);
								const steps = readArray(details.batchSteps).map(readRecord);
								assert.deepEqual(
									steps.map((step) =>
										step.command === undefined ? [] : readArray(step.command).slice(0, 2),
									),
									rows.map((row) => (mode === "command" ? row.slice(0, 2) : [])),
								);
								assert.deepEqual(
									steps.map((step) => step.index),
									rows.map((_, index) => (mode === "indexed-stdin" ? index + 1 : index)),
								);
								const aggregate = readArray(details.data).map(readRecord);
								assert.equal(Object.hasOwn(aggregate[0], "command"), mode === "command");
								assert.equal(aggregate.at(-1)?.success, true);
								assert.equal(readRecord(details.sessionTabTarget).url, url);
							});
						}
						await t.test("code", async () => {
							const codeTool = h.getTool("agent_browser_code");
							assert.ok(codeTool);
							const request = {
								args: ["batch", "--bail", "--omit-command"],
								stdin: JSON.stringify([[], ...rows]),
							};
							const outputPath = join(dir, "code.json");
							const result = await executeRegisteredTool(codeTool, h.ctx, {
								session,
								code: `const r=await browser(${JSON.stringify(request)}); emit({success:r.success,data:r.data});`,
								outputPath,
							});
							assert.equal(result.isError, false, JSON.stringify(result));
							assert.doesNotMatch(
								JSON.stringify(result),
								/indexed-cookie-secret|indexed-storage-secret/,
							);
							assert.doesNotMatch(
								await readFile(outputPath, "utf8"),
								/indexed-cookie-secret|indexed-storage-secret/,
							);
							assert.doesNotMatch(
								JSON.stringify(h.appendedEntries),
								/indexed-cookie-secret|indexed-storage-secret/,
							);
						});
						await t.test(
							"indexed recording recovery retains unrelated screenshot evidence",
							async () => {
								const path = join(dir, "before-inactive-stop.png");
								const result = await call(
									["batch", "--omit-command"],
									JSON.stringify([[], ["screenshot", path], ["record", "stop"]]),
								);
								assert.equal(result.isError, true);
								const details = readRecord(result.details);
								const recovery = readRecord(details.recordingRecovery);
								assert.match(
									readString(readRecord(recovery.attempt).error),
									/No recording in progress/i,
								);
								assert.equal(recovery.healed, false);
								const steps = readArray(details.batchSteps).map(readRecord);
								assert.deepEqual(
									steps.map((step) => step.index),
									[1, 2],
								);
								const screenshotStep = steps.find((step) => step.index === 1);
								assert.ok(screenshotStep);
								assert.notEqual(
									screenshotStep.artifactVerification,
									undefined,
									"recording recovery must retain the unrelated screenshot verification",
								);
								assert.equal(readRecord(screenshotStep.artifactVerification).verifiedCount, 1);
								assert.deepEqual(
									readArray(screenshotStep.artifacts).map(
										(artifact) => readRecord(artifact).absolutePath,
									),
									[path],
								);
							},
						);
						await t.test("indexed recording output keeps native receipts", async (recording) => {
							const secrets = /indexed-cookie-secret|indexed-storage-secret/;
							const argv = /"command":\s*\[/;
							for (const mode of ["command", "indexed"]) {
								// Command form is the parity control; indexed receipts must not echo argv.
								await recording.test(mode, async (receipts) => {
									const indexed = mode === "indexed";
									const batch = (plan: readonly (readonly string[])[], outputPath: string) =>
										call(
											["batch", "--bail", ...(indexed ? ["--omit-command"] : [])],
											JSON.stringify(indexed ? [[], ...plan] : plan),
											outputPath,
										);
									const saved = async (result: unknown, outputPath: string) => {
										const details = readRecord(readRecord(result).details);
										const outputFile = readRecord(details.outputFile);
										assert.equal(outputFile.status, "saved", JSON.stringify(details.outputFile));
										assert.equal(outputFile.source, "recording-receipt");
										const text = await readFile(outputPath, "utf8");
										assert.doesNotMatch(JSON.stringify(result), secrets);
										assert.doesNotMatch(text, secrets);
										assert.doesNotMatch(JSON.stringify(h.appendedEntries), secrets);
										assert.equal(argv.test(JSON.stringify(result)), !indexed);
										assert.equal(argv.test(text), !indexed);
										return { details, receipt: readRecord(JSON.parse(text)) };
									};
									const video = join(dir, `${mode}-receipt.webm`);
									const failedPath = join(dir, `${mode}-failed-receipt.json`);
									// --bail leaves the started recording active without a stop row to recover.
									const failed = await batch(
										[
											["record", "start", video],
											[
												"cookies",
												"set",
												"ordinary",
												"indexed-cookie-secret",
												"--url",
												fixture.baseUrl,
											],
											["storage", "local", "get", "ordinary"],
											["eval", "(() => { throw new Error('planned recording flow failure'); })()"],
											["record", "stop"],
										],
										failedPath,
									);
									const stoppedPath = join(dir, `${mode}-stopped-receipt.json`);
									// Stop before asserting so a failed check cannot leave the native recording active.
									// Keep the established explicit 12s capture for short/cold native Ubuntu encoders.
									const stopped = await batch(
										[
											["storage", "local", "get", "ordinary"],
											["wait", "12000"],
											["record", "stop"],
										],
										stoppedPath,
									);
									await receipts.test("unrecovered failure", async () => {
										assert.equal(failed.isError, true, JSON.stringify(failed));
										const failure = await saved(failed, failedPath);
										assert.equal(failure.details.recordingRecovery, undefined);
										assert.equal(
											readRecord(readRecord(failure.details.batchFailure).failedStep).index,
											indexed ? 4 : 3,
										);
										assert.equal(failure.receipt.success, false);
										assert.ok(
											readArray(failure.receipt.artifacts)
												.map(readRecord)
												.some(
													(artifact) =>
														artifact.absolutePath === video && artifact.status === "pending",
												),
											JSON.stringify(failure.receipt.artifacts),
										);
									});
									await receipts.test("success", async () => {
										assert.equal(stopped.isError, false, JSON.stringify(stopped));
										const success = await saved(stopped, stoppedPath);
										assert.equal(success.receipt.success, true);
										assert.equal(readRecord(success.receipt.artifactVerification).verifiedCount, 1);
										assert.equal(
											(await readFile(video)).subarray(0, 4).toString("hex"),
											"1a45dfa3",
										);
									});
								});
							}
						});
						const screenshot = join(dir, "after-empty.png");
						const observed = await call(
							["batch", "--bail", "--omit-command"],
							JSON.stringify([
								[],
								["close"],
								["open", url],
								[],
								["screenshot", screenshot],
								["snapshot", "-i"],
							]),
						);
						assert.equal(observed.isError, false, JSON.stringify(observed));
						assert.equal(readRecord(readRecord(observed.details).sessionTabTarget).url, url);
						assert.notEqual(readRecord(observed.details).refSnapshot, undefined);
						const observedSteps = readArray(readRecord(observed.details).batchSteps).map(
							readRecord,
						);
						assert.deepEqual(
							observedSteps.map((step) => step.index),
							[1, 2, 4, 5],
						);
						assert.equal(readRecord(observedSteps[2].artifactVerification).verifiedCount, 1);
						assert.ok((await readFile(screenshot)).byteLength > 0);
						const finish = h.appendedEntries
							.filter((entry) => entry.customType === BROWSER_TRANSITION_ENTRY)
							.map((entry) => readRecord(readRecord(entry.data).event))
							.findLast((entry) => entry.phase === "finish");
						assert.deepEqual(
							readArray(readRecord(finish?.state).batchSteps).map(
								(step) => readRecord(step).command,
							),
							[["close"], ["open", url], ["screenshot", screenshot], ["snapshot", "-i"]],
						);
						const reloaded = createExtensionHarness({
							cwd: dir,
							branch: [...h.ctx.sessionManager.getBranch()],
						});
						await runExtensionEvent(
							reloaded.handlers,
							"session_start",
							{ reason: "reload" },
							reloaded.ctx,
						);
						const stale = await executeRegisteredTool(reloaded.tool, reloaded.ctx, {
							args: ["--session", session, "get", "text", "@e999999"],
						});
						assert.equal(readRecord(stale.details).failureCategory, "stale-ref");
						assert.match(
							readString(readRecord(stale.content[0]).text),
							/not present in the latest snapshot for this session/,
						);
						const savedRefs = readArray(
							readRecord(readRecord(observed.details).refSnapshot).refIds,
						);
						assert.deepEqual(readRecord(stale.details).refIds, ["e999999"]);
						const resumed = await executeRegisteredTool(reloaded.tool, reloaded.ctx, {
							args: ["--session", session, "get", "text", `@${readString(savedRefs[0])}`],
						});
						assert.equal(resumed.isError, false, JSON.stringify(resumed));
						assert.equal(readRecord(readRecord(resumed.details).sessionTabTarget).url, url);
					} finally {
						await call(["close"]);
					}
				},
			);
		} finally {
			await fixture.close();
			await rm(socketDir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test("registered batch keeps empty raw input errors unchanged by ignored stdin", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "piab-empty-batch-"));
	const log = join(dir, "calls.jsonl");
	await writeFakeAgentBrowserBinary(
		dir,
		`const fs = require("node:fs"), args = process.argv.slice(2), stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, stdin}) + "\\n");
const data = {url:"https://fixture.test/",title:"Fixture"};
if (args.includes("snapshot")) Object.assign(data, {snapshot:'- button "Submit" [ref=e1]',refs:{e1:{role:"button",name:"Submit"}}});
console.log(JSON.stringify({success:true,data}));`,
	);
	try {
		await withPatchedEnv(
			{
				HOME: dir,
				USERPROFILE: dir,
				PI_CODING_AGENT_DIR: join(dir, "pi"),
				PI_AGENT_BROWSER_SOCKET_DIR: join(dir, "s"),
				PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
				AGENT_BROWSER_SESSION: undefined,
				AGENT_BROWSER_NAMESPACE: undefined,
				AGENT_BROWSER_CONFIG: undefined,
			},
			async () => {
				const h = createExtensionHarness({ cwd: dir });
				try {
					const snapshot = await executeRegisteredTool(h.tool, h.ctx, {
						args: ["--session", "empty-raw", "snapshot", "-i"],
					});
					assert.equal(snapshot.isError, false, snapshot.content[0].text);
					for (const raw of ["", "   "]) {
						await t.test(
							`raw ${JSON.stringify(raw)} rejects its own shape, not ignored stdin`,
							async () => {
								const ignoredDirectory = join(dir, `ignored-${raw.length}`);
								const stdin = JSON.stringify([
									["open"],
									["click", "@e999"],
									["screenshot", join(ignoredDirectory, "capture.png")],
								]);
								const args = ["--session", "empty-raw", "batch", raw];
								await writeFile(log, "");
								const baseline = await executeRegisteredTool(h.tool, h.ctx, { args });
								const result = await executeRegisteredTool(h.tool, h.ctx, { args, stdin });
								assert.equal(baseline.isError, true);
								assert.match(readString(baseline.content[0].text), /batch command is empty/);
								assert.equal(result.isError, true);
								assert.deepEqual(result.content, baseline.content);
								assert.deepEqual(result.details, baseline.details);
								const details = readRecord(result.details);
								assert.equal(details.agentBrowserStarted, undefined);
								assert.equal(details.exitCode, undefined);
								assert.equal(details.failureCategory, "validation-error");
								assert.deepEqual(
									await readInvocationLog(log),
									[],
									"invalid raw input must not dispatch ignored stdin or helpers",
								);
								await assert.rejects(stat(ignoredDirectory), { code: "ENOENT" });
								const followup = await executeRegisteredTool(h.tool, h.ctx, {
									args: ["--session", "empty-raw", "get", "text", "@e1"],
								});
								assert.equal(
									followup.isError,
									false,
									"ignored actions must not invalidate live refs",
								);
								assert.ok(
									(await readInvocationLog(log)).some((call) => call.args.includes("@e1")),
									"the preserved ref reaches native dispatch",
								);
							},
						);
					}
				} finally {
					await runExtensionEvent(h.handlers, "session_shutdown", { reason: "quit" }, h.ctx);
				}
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test(
	"real upstream artifact argv matches native operand selection",
	{ skip: !real, timeout: 120_000 },
	async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "av-"));
		const socketDir = join(dir, "s");
		await mkdir(socketDir, { mode: 0o700 });
		const fixture = await startAgentBrowserContractFixtureServer();
		try {
			await withPatchedEnv(
				{
					HOME: dir,
					USERPROFILE: dir,
					PI_CODING_AGENT_DIR: join(dir, "pi"),
					PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_CONFIG: undefined,
					AGENT_BROWSER_NAMESPACE: undefined,
					AGENT_BROWSER_PROFILE: undefined,
					AGENT_BROWSER_RESTORE: undefined,
					AGENT_BROWSER_CDP: undefined,
					AGENT_BROWSER_AUTO_CONNECT: undefined,
				},
				async () => {
					const session = `av-${randomUUID().slice(0, 8)}`;
					const prefix = ["--session", session];
					const h = createExtensionHarness({ cwd: dir, sessionId: randomUUID() });
					await runExtensionEvent(h.handlers, "session_start", { reason: "new" }, h.ctx);
					const call = (args: readonly string[], stdin?: string, timeoutMs?: number) =>
						executeRegisteredTool(h.tool, h.ctx, { args: [...prefix, ...args], stdin, timeoutMs });
					let daemonPid: number | undefined;
					try {
						const opened = await call(["open", `${fixture.baseUrl}/download`]);
						assert.equal(opened.isError, false, opened.content[0].text);
						daemonPid = Number(await readFile(join(socketDir, `${session}.pid`), "utf8"));
						await t.test("outer CLI globals still clean before PDF operand selection", async () => {
							const result = await call(["pdf", "--quick", "outer.pdf"]);
							const resultDetails = readRecord(result.details);
							assert.equal(result.isError, false, result.content[0].text);
							assert.equal(
								readArray(resultDetails.artifacts).map((value) => readRecord(value))[0]
									?.requestedPath,
								"outer.pdf",
							);
							assert.equal(
								(await readFile(join(dir, "outer.pdf"))).subarray(0, 5).toString(),
								"%PDF-",
							);
						});
						for (const [step, path, header] of [
							[["pdf", "--quick", "ignored/page.pdf"], "--quick", "%PDF-"],
							[
								["download", "#direct-download", "--quiet", "ignored/file.txt"],
								"--quiet",
								"download contract fixture report\n",
							],
							[
								["screenshot", "body", "--screenshot-dir", "ignored/shot.png"],
								"--screenshot-dir",
								"89504e470d0a1a0a",
							],
						] as const) {
							for (const raw of [false, true]) {
								await t.test(
									`${step[0]} ${raw ? "raw" : "stdin"} batch keeps its literal destination`,
									async () => {
										await rm(join(dir, path), { force: true });
										const result = await call(
											raw ? ["batch", step.join(" ")] : ["batch"],
											raw ? undefined : JSON.stringify([step]),
										);
										const resultDetails = readRecord(result.details);
										assert.equal(result.isError, false, result.content[0].text);
										const bytes = await readFile(join(dir, path));
										assert.equal(
											step[0] === "screenshot"
												? bytes.subarray(0, 8).toString("hex")
												: bytes.subarray(0, header.length).toString(),
											header,
										);
										const artifact = readArray(resultDetails.artifacts).map((value) =>
											readRecord(value),
										)[0];
										t.diagnostic(
											JSON.stringify({
												step,
												raw,
												nativePath: artifact.path,
												requestedPath: artifact.requestedPath,
												sizeBytes: bytes.length,
											}),
										);
										assert.equal(artifact.requestedPath, path);
										assert.equal(artifact.exists, true);
										await assert.rejects(stat(join(dir, "ignored")), { code: "ENOENT" });
									},
								);
							}
						}
						for (const flag of ["--download", "-d"]) {
							await t.test(
								`wait ${flag} keeps the operand after an interleaved timeout`,
								async (wait) => {
									const path = `wait-${flag.slice(1)}/capture.csv`;
									const result = await call(
										["batch"],
										JSON.stringify([
											["click", "#delayed-anchor-download"],
											["wait", flag, "--timeout", "30000", path, "ignored.csv"],
										]),
									);
									const resultDetails = readRecord(result.details);
									const artifact = readArray(resultDetails.artifacts).map((value) =>
										readRecord(value),
									)[0];
									t.diagnostic(
										JSON.stringify({
											flag,
											nativePath: artifact.path,
											requestedPath: artifact.requestedPath,
											exists: artifact.exists,
										}),
									);
									assert.equal(artifact.path, path);
									await wait.test(
										"prepares the native retained path's parent directory",
										async () => {
											assert.equal(
												(await stat(join(dir, `wait-${flag.slice(1)}`))).isDirectory(),
												true,
											);
										},
									);
									await wait.test("retains the native requested path in artifact metadata", () =>
										assert.equal(artifact.requestedPath, path),
									);
									// Native 0.36 reports the requested wait path without moving the completed download there.
									assert.equal(result.isError, true);
									assert.equal(artifact.exists, false);
									await assert.rejects(readFile(join(dir, path)), { code: "ENOENT" });
								},
							);
						}
						for (const raw of [false, true]) {
							await t.test(
								`timeout evidence follows ${raw ? "raw argv instead of ignored stdin" : "stdin native operands"}`,
								async () => {
									const pdf = `timeout-${raw}.pdf`;
									const download = `-timeout-${raw}.bin`;
									const steps = [
										["pdf", pdf, "ignored.pdf"],
										["download", "#direct-download", download, "ignored.bin"],
										["pdf", "--quick", "ignored.pdf"],
										["wait", "3000"],
									];
									const result = await call(
										raw ? ["batch", ...steps.map((step) => step.join(" "))] : ["batch"],
										JSON.stringify(raw ? [["pdf", "ignored-stdin.pdf"]] : steps),
										1000,
									);
									const resultDetails = readRecord(result.details);
									assert.equal(resultDetails.timedOut, true, result.content[0].text);
									assert.equal(resultDetails.agentBrowserStarted, true);
									assert.equal((await readFile(join(dir, pdf))).subarray(0, 5).toString(), "%PDF-");
									assert.equal(
										await readFile(join(dir, download), "utf8"),
										"download contract fixture report\n",
									);
									const progress = readRecord(resultDetails.timeoutPartialProgress);
									t.diagnostic(JSON.stringify({ raw, timeoutArtifacts: progress.artifacts }));
									assert.deepEqual(
										readArray(progress.artifacts)
											.map(readRecord)
											.map(({ path, exists }) => ({ path, exists })),
										[pdf, download, "--quick"].map((path) => ({ path, exists: true })),
									);
									await assert.rejects(stat(join(dir, "ignored-stdin.pdf")), { code: "ENOENT" });
								},
							);
						}
						for (const command of ["pdf", "screenshot"]) {
							await t.test(
								`multi-step timeout leaves ${command} recovery to inspection`,
								{ skip: process.platform === "win32" },
								async (retryTest) => {
									const ignored = `ignored-retry-${command}`;
									const step =
										command === "pdf"
											? [command, "--quick", ignored]
											: [command, "body", "--quick", ignored];
									const path = join(dir, "--quick");
									await rm(path, { force: true });
									await symlink("missing/retry-output", path);
									// The row fails before the wait, but the watchdog receives no per-row outcome.
									const timedOut = await call(
										["batch"],
										JSON.stringify([step, ["wait", "3000"]]),
										1000,
									);
									const timedOutDetails = readRecord(timedOut.details);
									assert.equal(timedOutDetails.timedOut, true, timedOut.content[0].text);
									assert.equal(timedOutDetails.agentBrowserStarted, true);
									const retry = readArray(timedOutDetails.nextActions)
										.map((value) => readRecord(value))
										.find((action) => action.id === "retry-timeout-step");
									assert.equal(retry, undefined);
									assert.doesNotMatch(
										readString(timedOut.content[0].text ?? ""),
										/Retry candidate|Retry failed step/,
									);
									assert.deepEqual(
										readArray(readRecord(timedOutDetails.timeoutPartialProgress).steps).map(
											(row) => readRecord(row).status,
										),
										["unknown", "unknown"],
									);
									await rm(path);
									const retried = await call(["batch"], JSON.stringify([step]));
									const retriedDetails = readRecord(retried.details);
									t.diagnostic(
										JSON.stringify({
											step,
											retriedError: retried.isError,
											retriedPaths: readArray(retriedDetails.artifacts ?? [])
												.map((value) => readRecord(value))
												.map((artifact) => artifact.path),
										}),
									);
									await retryTest.test(
										"explicitly rerunning the original row preserves its native destination",
										async () => {
											assert.equal(retried.isError, false, retried.content[0].text);
											const bytes = await readFile(path);
											assert.equal(
												command === "pdf"
													? bytes.subarray(0, 5).toString()
													: bytes.subarray(0, 8).toString("hex"),
												command === "pdf" ? "%PDF-" : "89504e470d0a1a0a",
											);
											await assert.rejects(stat(join(dir, ignored)), { code: "ENOENT" });
										},
									);
								},
							);
						}
						await t.test(
							"native recording reservations cover interleaved waits and literal batch paths",
							async (recording) => {
								const held = join(dir, "held.webm");
								const literal = join(dir, "--quick");
								await rm(literal, { force: true });
								await writeFile(held, "");
								await link(held, literal); // Keep the literal-global alias while 0.37 requires a recording extension.
								const started = await call(["record", "start", held]);
								const startedDetails = readRecord(started.details);
								assert.equal(started.isError, false, started.content[0].text);
								assert.equal(
									readArray(startedDetails.artifacts).map((value) => readRecord(value))[0]?.status,
									"pending",
								);
								for (const [index, params] of [
									{ args: [...prefix, "wait", "--download", "--timeout", "100", held] },
									{ args: [...prefix, "wait", "-d", "--timeout", "100", held] },
									{
										args: [...prefix, "batch"],
										stdin: JSON.stringify([["pdf", "--quick", "ignored.pdf"]]),
									},
									{ args: [...prefix, "batch", "download #direct-download --quick ignored.bin"] },
								].entries()) {
									await recording.test(
										`reserved native path rejects command ${index + 1}`,
										async () => {
											const blocked = await executeRegisteredTool(h.tool, h.ctx, params);
											const blockedDetails = readRecord(blocked.details);
											assert.equal(
												blockedDetails.failureCategory,
												"validation-error",
												blocked.content[0].text,
											);
											assert.match(
												readString(blocked.content[0].text ?? ""),
												/reserved by an active recording/,
											);
											assert.equal(blockedDetails.exitCode, undefined);
										},
									);
								}
								t.diagnostic(JSON.stringify({ reservedPath: held, nativeRecordingStarted: true }));
							},
						);
					} finally {
						const closed = await runAgentBrowserProcess({
							args: ["--json", ...prefix, "close"],
							cwd: dir,
						});
						assert.equal(closed.exitCode, 0, closed.stderr);
						await runExtensionEvent(h.handlers, "session_shutdown", { reason: "quit" }, h.ctx);
						assert.equal(
							await waitForTestPidExit(daemonPid, 10_000),
							true,
							"owned native daemon must exit",
						);
						t.diagnostic(JSON.stringify({ session, daemonPid, closed: true }));
					}
				},
			);
		} finally {
			await fixture.close();
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"real upstream recording FPS preserves destinations and the intended page",
	{ skip: !real, timeout: 180_000 },
	async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "rf-"));
		const socketDir = createShortPrivateSocketDir(dir);
		await mkdir(socketDir, { mode: 0o700, recursive: true });
		const fixture = await startAgentBrowserContractFixtureServer();
		const url = `${fixture.baseUrl}/contract`;
		try {
			await withPatchedEnv(
				{
					HOME: dir,
					USERPROFILE: dir,
					PI_CODING_AGENT_DIR: join(dir, "pi"),
					PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_CONFIG: undefined,
					AGENT_BROWSER_NAMESPACE: undefined,
					AGENT_BROWSER_PROFILE: undefined,
					AGENT_BROWSER_RESTORE: undefined,
					AGENT_BROWSER_CDP: undefined,
					AGENT_BROWSER_AUTO_CONNECT: undefined,
				},
				async () => {
					const version = (
						await runAgentBrowserProcess({ args: ["--version"], cwd: dir })
					).stdout.match(/agent-browser (\d+)\.(\d+)\./);
					assert.ok(version);
					if (Number(version[1]) === 0 && Number(version[2]) < 37) {
						t.skip(
							"Recording FPS requires native 0.37 or newer; older recording controls run separately.",
						);
						return;
					}
					const h = createExtensionHarness({ cwd: dir, sessionId: randomUUID() });
					await runExtensionEvent(h.handlers, "session_start", { reason: "new" }, h.ctx);
					const call = (args: readonly string[], stdin?: string, outputPath?: string) =>
						executeRegisteredTool(h.tool, h.ctx, { args, stdin, outputPath });
					let daemonPid: number | undefined;
					try {
						const opened = await executeRegisteredTool(h.tool, h.ctx, {
							args: ["open", url],
							sessionMode: "fresh",
						});
						const openedDetails = readRecord(opened.details);
						assert.equal(opened.isError, false, opened.content[0].text);
						const sessionName = openedDetails.sessionName;
						assert.ok(typeof sessionName === "string");
						daemonPid = Number(await readFile(join(socketDir, `${sessionName}.pid`), "utf8"));
						const owned = { cwd: dir, sessionName, restoreState: new ManagedSessionRestoreState() };
						const direct = (args: readonly string[]) =>
							withOwnedManagedSessionContext(owned, () =>
								runAgentBrowserProcess({
									args: ["--json", "--session", sessionName, ...args],
									cwd: dir,
								}),
							);
						for (const subcommand of ["start", "restart"]) {
							// Exhaustive fixture variant (["start", "restart"]): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal((await call(["open", url])).isError, false);
							// Exhaustive fixture variant (["start", "restart"]): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal((await direct(["tab", "new", "about:blank"])).exitCode, 0);
							const recovered = await call(["snapshot", "-i"]);
							const recoveredDetails = readRecord(recovered.details);
							// Exhaustive fixture variant (["start", "restart"]): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(readRecord(recoveredDetails.sessionTabCorrection).targetUrl, url);
							const snapshot = await call(["snapshot", "-i"]);
							const snapshotDetails = readRecord(snapshot.details);
							const refs = readRecord(snapshotDetails.refSnapshot).refs;
							const ref = Object.entries(readRecord(refs)).find(
								([, entry]) => readRecord(entry).name === "Go to next fixture page",
							)?.[0];
							// Exhaustive fixture variant (["start", "restart"]): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.ok(ref !== undefined && ref.length > 0);
							if (subcommand === "start") {
								const blocked = await call(
									["batch"],
									JSON.stringify([
										["record", "start", join(dir, "blocked.webm")],
										["get", "text", `@${ref}`],
									]),
								);
								const blockedDetails = readRecord(blocked.details);
								// Exhaustive fixture variant (subcommand === "start"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(
									blockedDetails.failureCategory,
									"stale-ref",
									"keep the older-native start-then-ref latch",
								);
								// Exhaustive fixture variant (subcommand === "start"): this selected path must satisfy its own contract.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.notEqual(blockedDetails.agentBrowserStarted, true);
							}
							// Exhaustive fixture variant (["start", "restart"]): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal((await direct(["tab", "new", `${fixture.baseUrl}/next`])).exitCode, 0);
							const path = join(dir, `${subcommand}.webm`);
							const args = ["record", subcommand, "--fps", "12", path];
							const recording = await call(args);
							const recordingDetails = readRecord(recording.details);
							// Exhaustive fixture variant (["start", "restart"]): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(recording.isError, false, recording.content[0].text);
							const observedUrl = readRecord(
								readRecord(JSON.parse((await direct(["get", "url"])).stdout)).data,
							).url;
							await t.test(`${subcommand} FPS retains the declared native destination`, () => {
								assert.equal(
									readArray(recordingDetails.artifacts)
										.map((value) => readRecord(value))
										.find((artifact) => artifact.subcommand === subcommand)?.requestedPath,
									path,
								);
								assert.deepEqual(
									readArray(recordingDetails.effectiveArgs)
										.map((value) => readString(value))
										.slice(-args.length),
									args,
								);
							});
							await t.test(
								`${subcommand} FPS records the pinned page rather than the drifted tab`,
								() => assert.equal(observedUrl, url),
							);
							await t.test(
								`${subcommand} FPS ref policy is conservative rather than false page-change evidence`,
								async () => {
									const invalidation = recordingDetails.refSnapshotInvalidation;
									const read = await call(["get", "text", `@${ref}`]);
									const readDetails = readRecord(read.details);
									if (subcommand === "start") {
										// Exhaustive fixture variant (subcommand === "start"): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(readDetails.failureCategory, "stale-ref");
										// Exhaustive fixture variant (subcommand === "start"): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.match(readString(readRecord(invalidation).summary), /conservatively/);
									} else {
										// Exhaustive fixture variant (subcommand === "start"): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(invalidation, undefined);
										// Exhaustive fixture variant (subcommand === "start"): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(read.isError, false, read.content[0].text);
									}
									assert.doesNotMatch(
										`${readString(recording.content[0].text)}\n${invalidation === undefined ? "undefined" : readString(readRecord(invalidation).summary)}`,
										/fresh active page|replaced or navigated/,
									);
								},
							);
							const began = Date.now();
							// Exhaustive fixture variant (["start", "restart"]): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal((await direct(["wait", "12000"])).exitCode, 0);
							t.diagnostic(
								JSON.stringify({
									subcommand,
									observedUrl,
									captureHoldMs: Date.now() - began,
									note: "Explicit 12s fixture capture; short/cold native Ubuntu captures can fail before encoding.",
								}),
							);
							const stopped = await call(["record", "stop"]);
							const stoppedDetails = readRecord(stopped.details);
							// Exhaustive fixture variant (["start", "restart"]): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(stopped.isError, false, stopped.content[0].text);
							// Exhaustive fixture variant (["start", "restart"]): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal((await readFile(path)).subarray(0, 4).toString("hex"), "1a45dfa3");
							// Exhaustive fixture variant (["start", "restart"]): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(readRecord(stoppedDetails.data).fps, 12);
						}
					} finally {
						await call(["close"]);
						await runExtensionEvent(h.handlers, "session_shutdown", { reason: "quit" }, h.ctx);
						assert.equal(
							await waitForTestPidExit(daemonPid, 10_000),
							true,
							"owned native daemon must exit",
						);
					}
				},
			);
		} finally {
			await fixture.close();
			await rm(socketDir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"real upstream batch argv and ref fidelity for pinned and unpinned registered tools",
	{ skip: !real, timeout: 180_000 },
	async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "bf-"));
		const socketDir = createShortPrivateSocketDir(dir);
		await mkdir(socketDir, { mode: 0o700, recursive: true });
		const browserBin = join(dir, "bin");
		await mkdir(browserBin);
		if (
			process.platform === "linux" &&
			process.env.AGENT_BROWSER_EXECUTABLE_PATH !== undefined &&
			process.env.AGENT_BROWSER_EXECUTABLE_PATH.length > 0
		) {
			await symlink(process.env.AGENT_BROWSER_EXECUTABLE_PATH, join(browserBin, "google-chrome"));
		}
		const fixture = await startAgentBrowserContractFixtureServer();
		const url = `${fixture.baseUrl}/contract`;
		const target = { title: "Agent Browser Contract Fixture", url };
		try {
			await withPatchedEnv(
				{
					HOME: dir,
					USERPROFILE: dir,
					PI_CODING_AGENT_DIR: join(dir, "pi"),
					PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_CONFIG: undefined,
					AGENT_BROWSER_NAMESPACE: undefined,
					AGENT_BROWSER_PROFILE: undefined,
					AGENT_BROWSER_RESTORE: undefined,
					AGENT_BROWSER_CDP: undefined,
					AGENT_BROWSER_AUTO_CONNECT: undefined,
					// Native browser discovery avoids passive launch flags reconfiguring the CDP fixture.
					AGENT_BROWSER_EXECUTABLE_PATH: undefined,
					PATH: `${browserBin}${delimiter}${process.env.PATH ?? ""}`,
				},
				async () => {
					for (const pinned of [false, true]) {
						const sessionName = `bf-${randomUUID().slice(0, 8)}`;
						const namespace = `bf-${randomUUID().slice(0, 8)}`;
						const prefix = ["--namespace", namespace, "--session", sessionName];
						const extraSessions: string[] = [];
						const direct = (args: readonly string[], stdin?: string) =>
							runAgentBrowserProcess({ args: ["--json", ...prefix, ...args], cwd: dir, stdin });
						const opened = await direct(["open", url]);
						// Exhaustive fixture variant ([false, true]): this selected path must satisfy its own contract.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(opened.exitCode, 0, opened.stderr);
						const makeHarness = async (extraDetails: Readonly<Record<string, unknown>> = {}) => {
							const h = createExtensionHarness({
								cwd: dir,
								sessionId: randomUUID(),
								branch: pinned
									? [
											createToolBranchEntry({
												details: {
													args: [...prefix, "open", url],
													command: "open",
													namespace,
													sessionName,
													sessionTabTarget: target,
													...extraDetails,
												},
												isError: false,
											}),
										]
									: [],
							});
							await runExtensionEvent(
								h.handlers,
								"session_start",
								{ reason: pinned ? "resume" : "new" },
								h.ctx,
							);
							return h;
						};
						let h = await makeHarness();
						if (pinned) {
							await direct(["tab", "new", `${fixture.baseUrl}/next`]);
						}
						const call = (args: readonly string[], stdin?: string) =>
							executeRegisteredTool(h.tool, h.ctx, { args: [...prefix, ...args], stdin });
						const nativeTabs = async () =>
							readArray(
								readRecord(readRecord(JSON.parse((await direct(["tab", "list"])).stdout)).data)
									.tabs,
							).map(readRecord);
						const keepActiveTab = async () => {
							const tabs = await nativeTabs();
							for (const tab of readArray(tabs).map(readRecord)) {
								if (!readBoolean(tab.active)) {
									const closed = await direct(["tab", "close", readString(tab.tabId)]);
									// Exhaustive fixture variant (!readBoolean(tab.active)): this selected path must satisfy its own contract.
									// oxlint-disable-next-line node-test/no-conditional-assertion
									assert.equal(closed.exitCode, 0, JSON.stringify(closed));
								}
							}
						};
						const label = pinned ? "pinned" : "unpinned";
						try {
							await t.test(
								`${label}: same-tab ref spellings remain usable and text stays literal`,
								async () => {
									const snapshot = await call(["snapshot", "-i"]);
									const snapshotDetails = readRecord(snapshot.details);
									assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
									const refs = readRecord(snapshotDetails.refSnapshot).refs;
									const id = Object.entries(readRecord(refs)).find(
										([, ref]) => readRecord(ref).name === "Name",
									)?.[0];
									assert.ok(id !== undefined && id.length > 0, JSON.stringify(refs));
									for (const ref of [`@${id}`, id, `ref=${id}`]) {
										const filled = await call(["fill", ref, "--bail"]);
										const filledDetails = readRecord(filled.details);
										// Exhaustive fixture variant ([`@${id}`, id, `ref=${id}`]): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(filled.isError, false, JSON.stringify(filled));
										// Exhaustive fixture variant ([`@${id}`, id, `ref=${id}`]): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.deepEqual(filledDetails.effectiveArgs, [
											"--json",
											...prefix,
											"fill",
											ref,
											"--bail",
										]);
									}
									for (const text of ["@e999", "e999", "ref=e999", "--bail=true"]) {
										// Exhaustive fixture variant (["@e999", "e999", "ref=e999", "--bail=true"]): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal((await call(["fill", "#name-input", text])).isError, false);
										const value = await direct(["get", "value", "#name-input"]);
										// Exhaustive fixture variant (["@e999", "e999", "ref=e999", "--bail=true"]): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(readRecord(readRecord(JSON.parse(value.stdout)).data).value, text);
									}
								},
							);
							await t.test(
								`${label}: mixed failures retain rows, category and returned tool failure`,
								async () => {
									for (const bail of [false, true]) {
										if (pinned) {
											// Exhaustive fixture variant (pinned): this selected path must satisfy its own contract.
											// oxlint-disable-next-line node-test/no-conditional-assertion
											assert.equal(
												(await direct(["tab", "new", `${fixture.baseUrl}/next`])).exitCode,
												0,
											);
										}
										const steps = [
											["fill", "#name-input", "before"],
											["not-a-command"],
											["fill", "#name-input", "after"],
										];
										const result = await call(
											["batch", ...(bail ? ["--bail"] : [])],
											JSON.stringify(steps),
										);
										const resultDetails = readRecord(result.details);
										// Exhaustive fixture variant ([false, true]): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(result.isError, true, JSON.stringify(result));
										// Exhaustive fixture variant ([false, true]): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(resultDetails.resultCategory, "failure");
										const rows = readArray(resultDetails.batchSteps).map((value) =>
											readRecord(value),
										);
										// Exhaustive fixture variant ([false, true]): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(rows.length, bail ? 2 : 3, JSON.stringify(result));
										// Exhaustive fixture variant ([false, true]): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.deepEqual(
											rows.map((row) => row.success),
											bail ? [true, false] : [true, false, true],
										);
										// Exhaustive fixture variant ([false, true]): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(
											readRecord(readRecord(resultDetails.batchFailure).failedStep).index,
											1,
										);
										// Exhaustive fixture variant ([false, true]): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.match(readString(result.content[0].text ?? ""), /Batch failed:/);
										// Exhaustive fixture variant ([false, true]): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(
											readRecord(
												readRecord(
													JSON.parse((await direct(["get", "value", "#name-input"])).stdout),
												).data,
											).value,
											bail ? "before" : "after",
										);
									}
								},
							);
							await t.test(
								`${label}: global headers and explicit native pin preferences survive dispatch`,
								async () => {
									if (pinned) {
										// Exhaustive fixture variant (pinned): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(
											(await direct(["tab", "new", `${fixture.baseUrl}/next`])).exitCode,
											0,
										);
									}
									const args = [
										"--headers",
										'{"x-fixture":"batch-fidelity"}',
										"--no-pin-tab",
										"batch",
										"--bail",
									];
									const result = await call(
										args,
										JSON.stringify([
											["open", `${fixture.baseUrl}/headers`],
											["get", "value", "#header-value"],
										]),
									);
									const resultDetails = readRecord(result.details);
									assert.equal(result.isError, false, JSON.stringify(result));
									assert.deepEqual(resultDetails.effectiveArgs, [
										"--json",
										...prefix,
										...args.map((arg) => (arg.startsWith("{") ? "[REDACTED]" : arg)),
									]);
									assert.equal(
										readRecord(
											readRecord(
												JSON.parse((await direct(["get", "value", "#header-value"])).stdout),
											).data,
										).value,
										"present",
									);
									assert.equal((await call(["open", url])).isError, false);
								},
							);
							await t.test(
								`${label}: raw argv wins over stdin and command timeout stays native`,
								async () => {
									const result = await call(
										["batch", "fill '#name-input' 'raw text'"],
										'[["fill","#name-input","ignored"]]',
									);
									assert.equal(result.isError, false, JSON.stringify(result));
									assert.equal(
										readRecord(
											readRecord(JSON.parse((await direct(["get", "value", "#name-input"])).stdout))
												.data,
										).value,
										"raw text",
									);
									const misplacedTimeout = await call([
										"--timeout",
										"50",
										"fill",
										"#name-input",
										"must-not-run",
									]);
									const misplacedTimeoutDetails = readRecord(misplacedTimeout.details);
									assert.equal(misplacedTimeout.isError, true, JSON.stringify(misplacedTimeout));
									assert.deepEqual(misplacedTimeoutDetails.effectiveArgs, [
										"--json",
										...prefix,
										"--timeout",
										"50",
										"fill",
										"#name-input",
										"must-not-run",
									]);
									assert.equal(
										readRecord(
											readRecord(JSON.parse((await direct(["get", "value", "#name-input"])).stdout))
												.data,
										).value,
										"raw text",
									);
									const wait = await call([
										"wait",
										"--text",
										"not present in fixture",
										"--timeout",
										"50",
									]);
									const waitDetails = readRecord(wait.details);
									assert.equal(wait.isError, true);
									assert.deepEqual(waitDetails.effectiveArgs, [
										"--json",
										...prefix,
										"wait",
										"--text",
										"not present in fixture",
										"--timeout",
										"50",
									]);
									const bad = await call(
										["batch", "--bail=true"],
										'[["fill","#name-input","ignored"]]',
									);
									const badDetails = readRecord(bad.details);
									assert.match(
										readString(bad.content[0].text ?? ""),
										/exact.*--bail.*stdin.*ignored/i,
									);
									assert.equal(badDetails.exitCode, undefined);
								},
							);
							await t.test(
								`${label}: stale spellings reject before upstream and key/mouse literals are not refs`,
								async () => {
									await call(["snapshot", "-i"]);
									for (const ref of ["@e999", "e999", "ref=e999"]) {
										const stale = await call(["fill", ref, "wrong"]);
										const staleDetails = readRecord(stale.details);
										// Exhaustive fixture variant (["@e999", "e999", "ref=e999"]): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(staleDetails.failureCategory, "stale-ref", JSON.stringify(stale));
										// Exhaustive fixture variant (["@e999", "e999", "ref=e999"]): this selected path must satisfy its own contract.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(staleDetails.exitCode, undefined);
									}
									await call(["focus", "#name-input"]);
									for (const args of [
										["keyboard", "inserttext", "@e999"],
										["press", "@e999"],
										["key", "@e999"],
										["mouse", "wheel", "@e999"],
									]) {
										const result = await call(args);
										const resultDetails = readRecord(result.details);
										// Every keyboard/mouse literal variant is dispatched and checked, never mistaken for a ref.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.notEqual(
											resultDetails.failureCategory,
											"stale-ref",
											JSON.stringify(result),
										);
										// Every keyboard/mouse literal variant is dispatched and checked, never mistaken for a ref.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(resultDetails.agentBrowserStarted, true, JSON.stringify(result));
									}
								},
							);
							await t.test(
								`${label}: CSS-only selectors remain literal while ref consumers stay guarded`,
								async (css) => {
									assert.equal((await call(["open", url])).isError, false);
									assert.equal(
										(
											await direct([
												"eval",
												"document.body.insertAdjacentHTML('beforeend', '<e999><p>Literal subtree</p></e999>')",
											])
										).exitCode,
										0,
									);
									assert.equal((await call(["snapshot", "-i"])).isError, false);
									await css.test("get count treats bare eN as a CSS tag", async () => {
										for (const [selector, count] of [
											["e999", 1],
											["e998", 0],
										] as const) {
											const counted = await call(["get", "count", selector]);
											const countedDetails = readRecord(counted.details);
											// Exhaustive fixture variant ([ ["e999", 1], ["e998", 0], ] as const): this selected path must satisfy its own contract.
											// oxlint-disable-next-line node-test/no-conditional-assertion
											assert.equal(counted.isError, false, JSON.stringify(counted));
											// Exhaustive fixture variant ([ ["e999", 1], ["e998", 0], ] as const): this selected path must satisfy its own contract.
											// oxlint-disable-next-line node-test/no-conditional-assertion
											assert.equal(readRecord(countedDetails.data).count, count);
										}
									});
									await css.test("diff snapshot treats bare eN as a CSS subtree", async () => {
										const args = ["diff", "snapshot", "--selector", "e999"];
										const compared = await call(args);
										const comparedDetails = readRecord(compared.details);
										assert.equal(compared.isError, false, JSON.stringify(compared));
										assert.match(
											readString(readRecord(comparedDetails.data).diff),
											/Literal subtree/,
										);
									});
								},
							);
							if (pinned) {
								await t.test("pinned: same-URL tabs retain the known titled target", async () => {
									await keepActiveTab();
									await direct(["open", url]);
									const originalTabs = await nativeTabs();
									const originalTab = readRecord(
										originalTabs.find((tab) => readBoolean(tab.active)),
									);
									const original = readString(originalTab.tabId);
									h = await makeHarness({ sessionTabTarget: { title: originalTab.title, url } });
									await direct(["tab", "new", url]);
									await direct(["eval", "document.title = 'Different tab'"]);
									const duplicateTabs = await nativeTabs();
									const duplicate = readString(
										readRecord(duplicateTabs.find((tab) => readBoolean(tab.active))).tabId,
									);
									await direct(["tab", duplicate]); // Native selection refreshes the cached tab title.
									assert.equal(
										readRecord((await nativeTabs()).find((tab) => tab.tabId === duplicate)).title,
										"Different tab",
									);
									const filled = await call(["fill", "#name-input", "intended"]);
									const filledDetails = readRecord(filled.details);
									assert.equal(filled.isError, false, JSON.stringify(filled));
									assert.equal(
										readRecord(filledDetails.sessionTabCorrection ?? {}).selectedTab,
										originalTab.targetId,
										JSON.stringify({ original, duplicate, originalTabs, duplicateTabs, filled }),
									);
									assert.equal(
										readRecord(filledDetails.sessionTabCorrection ?? {}).selectionKind,
										"targetId",
									);
									await direct(["tab", duplicate]);
									assert.equal(
										readRecord(
											readRecord(JSON.parse((await direct(["get", "value", "#name-input"])).stdout))
												.data,
										).value,
										"",
									);
									await direct(["tab", original]);
								});
							}
							if (pinned) {
								await t.test(
									"pinned: actual tab switch refreshes refs before same-page actions",
									async () => {
										const snapshot = await call(["snapshot", "-i"]);
										const snapshotDetails = readRecord(snapshot.details);
										const refs = readRecord(snapshotDetails.refSnapshot).refs;
										const id = Object.entries(readRecord(refs)).find(
											([, ref]) => readRecord(ref).name === "Name",
										)?.[0];
										assert.ok(id !== undefined && id.length > 0);
										await direct(["tab", "new", `${fixture.baseUrl}/next`]);
										const filled = await call(["fill", `ref=${id}`, "switched"]);
										const filledDetails = readRecord(filled.details);
										assert.equal(filled.isError, false, JSON.stringify(filled));
										assert.doesNotThrow(() => {
											readRecord(filledDetails.sessionTabCorrection);
										});
										assert.equal(
											readRecord(
												readRecord(
													JSON.parse((await direct(["get", "value", "#name-input"])).stdout),
												).data,
											).value,
											"switched",
										);
									},
								);
							}
							if (pinned && process.platform !== "win32") {
								await t.test(
									"pinned: native selection failure and post-selection mismatch execute zero user steps",
									async () => {
										const binary = execFileSync("which", ["agent-browser"], {
											encoding: "utf8",
										}).trim();
										const shimDir = join(dir, "shim");
										await mkdir(shimDir);
										const modeFile = join(shimDir, "fault");
										await writeFakeAgentBrowserBinary(
											shimDir,
											`const fs = require('node:fs'); const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2), input = fs.readFileSync(0, 'utf8'), i = args.indexOf('tab');
const run = (a) => spawnSync(${JSON.stringify(binary)}, a, { input, encoding: 'utf8' });
const fault = fs.existsSync(${JSON.stringify(modeFile)}) ? fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8') : '';
if (fault && i >= 0 && args[i+1] !== 'list' && args[i+1] !== 'new' && args[i+1] !== 'close') {
 fs.unlinkSync(${JSON.stringify(modeFile)});
 if (fault === 'gone') run([...args.slice(0, i), 'tab', 'close', args[i+1]]);
}
const result = run(args);
if (fault === 'mismatch' && i >= 0 && args[i+1] !== 'list') run([...args.slice(0,i), 'tab', 'new', ${JSON.stringify(`${fixture.baseUrl}/next`)}]);
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);`,
										);
										for (const fault of ["mismatch", "gone"]) {
											await direct(["open", url]);
											h = await makeHarness();
											await direct(["tab", "new", `${fixture.baseUrl}/next`]);
											await writeFile(modeFile, fault);
											await withPatchedEnv(
												{ PATH: `${shimDir}:${process.env.PATH ?? ""}` },
												async () => {
													const blocked = await call(
														["batch"],
														'[["eval","document.body.dataset.wrong=1"]]',
													);
													const blockedDetails = readRecord(blocked.details);
													// Exhaustive fixture variant (["mismatch", "gone"]): this selected path must satisfy its own contract.
													// oxlint-disable-next-line node-test/no-conditional-assertion
													assert.equal(
														blockedDetails.failureCategory,
														"tab-drift",
														JSON.stringify(blocked),
													);
													// Exhaustive fixture variant (["mismatch", "gone"]): this selected path must satisfy its own contract.
													// oxlint-disable-next-line node-test/no-conditional-assertion
													assert.equal(blockedDetails.exitCode, undefined);
												},
											);
											// Exhaustive fixture variant (["mismatch", "gone"]): this selected path must satisfy its own contract.
											// oxlint-disable-next-line node-test/no-conditional-assertion
											assert.equal(
												readRecord(
													readRecord(
														JSON.parse(
															(await direct(["eval", "document.body.dataset.wrong || 'untouched'"]))
																.stdout,
														),
													).data,
												).result,
												"untouched",
											);
										}
										await direct(["open", url]);
									},
								);
							}
							if (pinned) {
								await t.test(
									"pinned: explicit connect replaces the target and failed recovery preserves batch flow",
									async () => {
										assert.equal((await direct(["close"])).exitCode, 0);
										const sourceSession = `cdp-${randomUUID().slice(0, 8)}`;
										extraSessions.push(sourceSession);
										const source = (args: readonly string[]) =>
											runAgentBrowserProcess({
												args: [
													"--json",
													"--namespace",
													namespace,
													"--session",
													sourceSession,
													...args,
												],
												cwd: dir,
											});
										const openedSource = await source(["open", url]);
										assert.equal(openedSource.exitCode, 0, JSON.stringify(openedSource));
										const endpoint = readRecord(
											readRecord(JSON.parse((await source(["get", "cdp-url"])).stdout)).data,
										).cdpUrl;
										assert.equal(typeof endpoint, "string");
										h = await makeHarness({
											sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` },
										});
										const connected = await call(["connect", readString(endpoint)]);
										const connectedDetails = readRecord(connected.details);
										assert.equal(connected.isError, false, JSON.stringify(connected));
										assert.equal(connectedDetails.refSnapshot, undefined);
										assert.equal((await call(["get", "url"])).isError, false);
										const attachedTabs = await call(["tab", "list"]);
										const attachedTabsDetails = readRecord(attachedTabs.details);
										const attachedTab = readArray(readRecord(attachedTabsDetails.data).tabs)
											.map(readRecord)
											.find((tab) => tab.url === url);
										assert.ok(attachedTab, JSON.stringify(attachedTabs));
										assert.equal(
											(await call(["tab", readString(attachedTab.tabId)])).isError,
											false,
										);
										assert.equal((await call(["snapshot", "-i"])).isError, false);
										const filledConnected = await call(["fill", "#name-input", "connected"]);
										assert.equal(filledConnected.isError, false, JSON.stringify(filledConnected));
										assert.equal(
											readRecord(
												readRecord(
													JSON.parse((await source(["get", "value", "#name-input"])).stdout),
												).data,
											).value,
											"connected",
										);
										const unsafe = await call(
											["batch"],
											JSON.stringify([
												["connect", "1"],
												["fill", "#name-input", "must-not-run"],
											]),
										);
										const unsafeDetails = readRecord(unsafe.details);
										assert.match(
											readString(unsafeDetails.validationError),
											/unverified|batch --bail/,
										);
										assert.equal(unsafeDetails.exitCode, undefined);
										h = await makeHarness({
											sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` },
										});
										const failed = await call(
											["batch"],
											JSON.stringify([
												["connect", "1"],
												["get", "url"],
											]),
										);
										const failedDetails = readRecord(failed.details);
										assert.equal(failed.isError, true);
										assert.deepEqual(
											readArray(failedDetails.batchSteps)
												.map((value) => readRecord(value))
												.map((row) => row.success),
											[false, true],
										);
									},
								);
							}
							if (pinned) {
								await t.test(
									"pinned: explicit state replay verifies the new page without inventing fresh refs",
									async () => {
										await direct(["open", `${fixture.baseUrl}/next`]);
										const statePath = join(dir, "fixture-state.json");
										await writeFile(
											statePath,
											JSON.stringify({
												cookies: [],
												origins: [
													{
														origin: fixture.baseUrl,
														localStorage: [{ name: "fidelity", value: "loaded" }],
													},
												],
											}),
										);
										h = await makeHarness({
											sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` },
										});
										const loaded = await call(["state", "load", statePath]);
										const loadedDetails = readRecord(loaded.details);
										assert.equal(loaded.isError, false, JSON.stringify(loaded));
										assert.equal(loadedDetails.refSnapshot, undefined);
										assert.equal((await call(["get", "url"])).isError, false);
										assert.equal(
											readRecord(
												readRecord(
													JSON.parse(
														(await direct(["eval", "localStorage.getItem('fidelity')"])).stdout,
													),
												).data,
											).result,
											"loaded",
										);
										const unsafe = await call(
											["batch"],
											JSON.stringify([
												["state", "load", `${statePath}.missing`],
												["fill", "#name-input", "must-not-run"],
											]),
										);
										const unsafeDetails = readRecord(unsafe.details);
										assert.match(
											readString(unsafeDetails.validationError),
											/unverified|batch --bail/,
										);
										assert.equal(unsafeDetails.exitCode, undefined);
										h = await makeHarness({
											sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` },
										});
										const failed = await call(
											["batch"],
											JSON.stringify([
												["state", "load", `${statePath}.missing`],
												["get", "url"],
											]),
										);
										const failedDetails = readRecord(failed.details);
										assert.equal(failed.isError, true);
										assert.deepEqual(
											readArray(failedDetails.batchSteps)
												.map((value) => readRecord(value))
												.map((row) => row.success),
											[false, true],
										);
										h = await makeHarness({
											sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` },
										});
										const replay = await call(
											["batch", "--bail"],
											JSON.stringify([
												["state", "load", statePath],
												["get", "url"],
												["snapshot", "-i"],
											]),
										);
										const replayDetails = readRecord(replay.details);
										assert.equal(replay.isError, false, JSON.stringify(replay));
										assert.doesNotThrow(() => {
											readRecord(replayDetails.refSnapshot);
										});
									},
								);
							}
							if (pinned) {
								await t.test(
									"pinned: sessionless commands do not require the prior page",
									async (local) => {
										h = await makeHarness({
											sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` },
										});
										const skills = await call(["skills", "list"]);
										const skillsDetails = readRecord(skills.details);
										assert.equal(skills.isError, false, JSON.stringify(skills));
										assert.deepEqual(skillsDetails.effectiveArgs, [
											"--json",
											...prefix,
											"skills",
											"list",
										]);
										for (const readOnly of [undefined, ["tab", "list"], ["tab"], ["get", "url"]]) {
											await local.test(
												`then ${readOnly?.join(" ") ?? "direct fill"} preserves the intended tab`,
												async () => {
													await keepActiveTab();
													assert.equal((await direct(["open", url])).exitCode, 0);
													const intended = readString(
														readRecord((await nativeTabs()).find((tab) => readBoolean(tab.active)))
															.tabId,
													);
													assert.equal(
														(await direct(["tab", "new", `${url}?other-tab`])).exitCode,
														0,
													);
													const other = readString(
														readRecord((await nativeTabs()).find((tab) => readBoolean(tab.active)))
															.tabId,
													);
													assert.equal(
														(await direct(["fill", "#name-input", "untouched"])).exitCode,
														0,
													);
													h = await makeHarness();
													assert.equal((await call(["skills", "list"])).isError, false);
													const fill = ["fill", "#name-input", "intended"];
													const filled = readOnly
														? await call(["batch"], JSON.stringify([readOnly, fill]))
														: await call(fill);
													assert.equal(filled.isError, false, JSON.stringify(filled));
													assert.equal((await direct(["tab", other])).exitCode, 0);
													assert.equal(
														readRecord(
															readRecord(
																JSON.parse((await direct(["get", "value", "#name-input"])).stdout),
															).data,
														).value,
														"untouched",
														"local success must not let a later action mutate the other tab",
													);
													assert.equal((await direct(["tab", intended])).exitCode, 0);
													assert.equal(
														readRecord(
															readRecord(
																JSON.parse((await direct(["get", "value", "#name-input"])).stdout),
															).data,
														).value,
														"intended",
													);
												},
											);
										}
										await local.test(
											"auth metadata cannot replace the intended page for a later action",
											async () => {
												await keepActiveTab();
												assert.equal((await direct(["open", url])).exitCode, 0);
												const intended = readString(
													readRecord((await nativeTabs()).find((tab) => readBoolean(tab.active)))
														.tabId,
												);
												assert.equal(
													(await direct(["tab", "new", `${url}?other-tab`])).exitCode,
													0,
												);
												const other = readString(
													readRecord((await nativeTabs()).find((tab) => readBoolean(tab.active)))
														.tabId,
												);
												assert.equal(
													(await direct(["fill", "#name-input", "untouched"])).exitCode,
													0,
												);
												h = await makeHarness();
												const saved = await call(
													[
														"auth",
														"save",
														"fixture",
														"--url",
														`${fixture.baseUrl}/auth-metadata`,
														"--username",
														"synthetic-user",
														"--password-stdin",
													],
													"synthetic-password",
												);
												const savedDetails = readRecord(saved.details);
												assert.equal(saved.isError, false, JSON.stringify(saved));
												const filled = await call(["fill", "#name-input", "intended"]);
												assert.equal(filled.isError, false, JSON.stringify(filled));
												assert.equal((await direct(["tab", other])).exitCode, 0);
												assert.equal(
													readRecord(
														readRecord(
															JSON.parse((await direct(["get", "value", "#name-input"])).stdout),
														).data,
													).value,
													"untouched",
													"local auth metadata must not let a later action mutate the other tab",
												);
												assert.equal((await direct(["tab", intended])).exitCode, 0);
												assert.equal(
													readRecord(
														readRecord(
															JSON.parse((await direct(["get", "value", "#name-input"])).stdout),
														).data,
													).value,
													"intended",
												);
												assert.equal(readRecord(savedDetails.sessionTabTarget).url, url);
											},
										);
										await local.test(
											"explicit get url chooses the live page for subsequent content",
											async () => {
												await keepActiveTab();
												assert.equal((await direct(["open", `${url}?chosen-page`])).exitCode, 0);
												h = await makeHarness();
												assert.equal((await call(["skills", "list"])).isError, false);
												const verified = await call(["get", "url"]);
												const verifiedDetails = readRecord(verified.details);
												assert.equal(verified.isError, false, JSON.stringify(verified));
												assert.equal(
													readRecord(verifiedDetails.sessionTabTarget).url,
													`${url}?chosen-page`,
												);
												assert.equal(
													(await call(["fill", "#name-input", "chosen"])).isError,
													false,
												);
												assert.equal(
													readRecord(
														readRecord(
															JSON.parse((await direct(["get", "value", "#name-input"])).stdout),
														).data,
													).value,
													"chosen",
												);
											},
										);
									},
								);
							}
							if (pinned) {
								await t.test("pinned: missing intended tab runs zero user steps", async () => {
									await keepActiveTab();
									h = await makeHarness();
									const changedPage = await direct(["open", `${fixture.baseUrl}/next`]);
									assert.equal(changedPage.exitCode, 0, JSON.stringify(changedPage));
									const blocked = await call(
										["batch"],
										'[["eval","document.body.dataset.wrong=1"]]',
									);
									const blockedDetails = readRecord(blocked.details);
									assert.equal(blocked.isError, true, JSON.stringify(blocked));
									assert.equal(blockedDetails.failureCategory, "tab-drift");
									assert.equal(blockedDetails.exitCode, undefined);
									assert.equal(
										readRecord(
											readRecord(
												JSON.parse(
													(await direct(["eval", "document.body.dataset.wrong || 'untouched'"]))
														.stdout,
												),
											).data,
										).result,
										"untouched",
									);
									const recovered = await call(
										["batch", "--bail"],
										JSON.stringify([
											["tab", "new", url],
											["get", "url"],
											["snapshot", "-i"],
										]),
									);
									assert.equal(recovered.isError, false, JSON.stringify(recovered));
								});
							}
						} finally {
							// Exhaustive fixture variant ([false, true]): this selected path must satisfy its own contract.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal((await direct(["close"])).exitCode, 0);
							for (const extraSession of extraSessions) {
								await runAgentBrowserProcess({
									args: ["--json", "--namespace", namespace, "--session", extraSession, "close"],
									cwd: dir,
								});
							}
							await runExtensionEvent(h.handlers, "session_shutdown", { reason: "quit" }, h.ctx);
						}
					}
				},
			);
		} finally {
			await fixture.close();
			await rm(socketDir, { force: true, recursive: true });
			await rm(dir, { force: true, recursive: true });
		}
	},
);
