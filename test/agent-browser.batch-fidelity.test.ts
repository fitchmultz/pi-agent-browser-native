import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES, GLOBAL_VALUE_FLAGS, VALUE_FLAGS } from "../extensions/agent-browser/lib/argv-grammar.js";
import { TARGET_AGENT_BROWSER_VERSION } from "../scripts/agent-browser-target.mjs";
import { getGuardedRefUsage, shouldPinSessionTabForCommand } from "../extensions/agent-browser/lib/orchestration/browser-run/session-state.js";
import { getPageTargetValidationError } from "../extensions/agent-browser/lib/page-target-validation.js";
import { runAgentBrowserProcess } from "../extensions/agent-browser/lib/process.js";
import type { AgentBrowserNextAction, FileArtifactMetadata } from "../extensions/agent-browser/lib/results/contracts.js";
import { waitForTestPidExit } from "./helpers/extension-validation-fixtures.js";

import {
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	runExtensionEvent,
	runExtensionEventResults,
	startAgentBrowserContractFixtureServer,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test("global argv flags match the audited upstream grammar baseline", async () => {
	const grammar = JSON.parse(await readFile(new URL("./fixtures/agent-browser-argv-grammar.json", import.meta.url), "utf8"));
	assert.equal(grammar.version, TARGET_AGENT_BROWSER_VERSION, "Re-audit flags.rs clean_args when rebaselining upstream");
	assert.deepEqual(new Set(GLOBAL_VALUE_FLAGS), new Set(grammar.globalValueFlags));
	assert.deepEqual(GLOBAL_BOOLEAN_FLAGS_WITH_OPTIONAL_VALUES, new Set(grammar.globalBooleanFlags));
	for (const flag of grammar.globalValueFlags) assert.equal(VALUE_FLAGS.has(flag), true, flag);
});

test("ref guards follow upstream selector slots, not literal operands or key/mouse data", () => {
	for (const ref of ["@e1", "e1", "ref=e1", " ref=e1 "]) {
		for (const args of [["fill", ref, "text"], ...["text", "html", "value", "attr", "box", "styles"].map((getter) => ["get", getter, ref]), ["drag", "#source", ref], ["click", "--new-tab", ref], ["scroll", "down", "--selector", ref], ["diff", "screenshot", "-s", ref]]) {
			assert.deepEqual(getGuardedRefUsage(args), ["e1"], JSON.stringify(args));
		}
	}
	for (const args of [
		["fill", "#field", "@e1"], ["type", "#field", "ref=e1"], ["select", "#field", "e1"],
		["download", "#link", "@e1"], ["upload", "#field", "@e1"], ["get", "attr", "#field", "@e1"],
		["press", "@e1"], ["key", "@e1"], ["keyboard", "inserttext", "@e1"], ["mouse", "wheel", "@e1"],
		["screenshot", "#field", "@e1"], ["diff", "screenshot", "-b", "@e1", "-o", "@e2"],
		["click", "@e1-suffix"], ["scroll", "@e1"], ["get", "url", "@e1"],
		["get", "count", "e999"], ["diff", "snapshot", "--selector", "e999"], ["diff", "snapshot", "-s", "@e999"],
	]) assert.deepEqual(getGuardedRefUsage(args), [], JSON.stringify(args));
});

test("tab pinning leaves explicit recovery available but still guards content after read-only batch prefixes", () => {
	for (const first of [["tab", "list"], ["tab"], ["session", "info"], ["get", "url"]]) {
		assert.equal(shouldPinSessionTabForCommand({ command: "batch", commandTokens: ["batch"], stdin: JSON.stringify([first, ["fill", "#field", "text"]]), pinningRequired: true, sessionName: "named" }), true);
	}
	for (const first of [["tab", "t1"], ["tab", "new", "about:blank"], ["open", "about:blank"], ["close"], ["connect", "9222"], ["state", "load", "state.json"]]) {
		assert.equal(shouldPinSessionTabForCommand({ command: "batch", commandTokens: ["batch"], stdin: JSON.stringify([first, ["get", "url"]]), pinningRequired: true, sessionName: "named" }), false);
	}
	for (const commandTokens of [["get", "url"], ["skills", "list"], ["auth", "save", "fixture", "--url", "https://example.test/", "--username", "fixture", "--password-stdin"], ["connect", "9222"], ["state", "load", "state.json"]]) {
		assert.equal(shouldPinSessionTabForCommand({ command: commandTokens[0], commandTokens, pinningRequired: true, sessionName: "named" }), false);
	}
});

test("history and page actions still require the intended tab", () => {
	for (const commandTokens of [["back"], ["forward"], ["reload"], ["click", "#field"], ["frame", "#child"]]) {
		assert.equal(shouldPinSessionTabForCommand({ command: commandTokens[0], commandTokens, pinningRequired: true, sessionName: "named" }), true);
	}
});

test("recording FPS options alone keep the intended tab", () => {
	for (const subcommand of ["start", "restart"]) {
		for (const step of [
			["record", subcommand, "capture.webm", "--fps", "30"],
			["record", subcommand, "--fps", "12", "capture.webm", "--fps", "24"],
		]) {
			assert.equal(shouldPinSessionTabForCommand({ command: "record", commandTokens: step, pinningRequired: true, sessionName: "named" }), true, JSON.stringify(step));
			assert.equal(shouldPinSessionTabForCommand({ command: "batch", commandTokens: ["batch"], stdin: JSON.stringify([step]), pinningRequired: true, sessionName: "named" }), true);
			assert.equal(shouldPinSessionTabForCommand({ command: "batch", commandTokens: ["batch", step.join(" ")], stdin: '[["open","https://ignored.example/"]]', pinningRequired: true, sessionName: "named" }), true);
			for (const withUrl of [[...step, "https://chosen.example/"], ["record", subcommand, "capture.webm", "https://chosen.example/", "--fps", "24"]]) {
				assert.equal(shouldPinSessionTabForCommand({ command: "record", commandTokens: withUrl, pinningRequired: true, sessionName: "named" }), false);
			}
		}
	}
});

test("unsupported batch bail assignment explains raw argv precedence without recovering ignored stdin", () => {
	for (const pageUrlUnknown of [false, true]) {
		assert.match(getPageTargetValidationError({ args: ["batch", "--bail=true"], stdin: '[["get","url"]]', pageUrlUnknown }) ?? "", /exact.*--bail.*stdin.*ignored/i);
	}
	assert.equal(getPageTargetValidationError({ args: ["batch", "fill '#field' '--bail=true'"], pageUrlUnknown: false }), undefined);
});

const real = process.env.PI_AGENT_BROWSER_REAL_UPSTREAM === "1";

test("real upstream artifact argv matches native operand selection", { skip: !real, timeout: 120_000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "av-"));
	const socketDir = join(dir, "s");
	await mkdir(socketDir, { mode: 0o700 });
	const fixture = await startAgentBrowserContractFixtureServer();
	try {
		await withPatchedEnv({
			HOME: dir, USERPROFILE: dir, PI_CODING_AGENT_DIR: join(dir, "pi"),
			PI_AGENT_BROWSER_SOCKET_DIR: socketDir, AGENT_BROWSER_SOCKET_DIR: socketDir,
			AGENT_BROWSER_CONFIG: undefined, AGENT_BROWSER_NAMESPACE: undefined,
			AGENT_BROWSER_PROFILE: undefined, AGENT_BROWSER_RESTORE: undefined,
			AGENT_BROWSER_CDP: undefined, AGENT_BROWSER_AUTO_CONNECT: undefined,
		}, async () => {
			const session = `av-${randomUUID().slice(0, 8)}`;
			const prefix = ["--session", session];
			const h = createExtensionHarness({ cwd: dir, sessionId: randomUUID() });
			await runExtensionEvent(h.handlers, "session_start", { reason: "new" }, h.ctx);
			const call = (args: string[], stdin?: string, timeoutMs?: number) => executeRegisteredTool(h.tool, h.ctx, { args: [...prefix, ...args], stdin, timeoutMs });
			let daemonPid: number | undefined;
			try {
				const opened = await call(["open", `${fixture.baseUrl}/download`]);
				assert.equal(opened.isError, false, opened.content[0]?.text);
				daemonPid = Number(await readFile(join(socketDir, `${session}.pid`), "utf8"));
				await t.test("outer CLI globals still clean before PDF operand selection", async () => {
					const result = await call(["pdf", "--quick", "outer.pdf"]);
					assert.equal(result.isError, false, result.content[0]?.text);
					assert.equal((result.details?.artifacts as FileArtifactMetadata[])[0]?.requestedPath, "outer.pdf");
					assert.equal((await readFile(join(dir, "outer.pdf"))).subarray(0, 5).toString(), "%PDF-");
				});
				for (const [step, path, header] of [
					[["pdf", "--quick", "ignored/page.pdf"], "--quick", "%PDF-"],
					[["download", "#direct-download", "--quiet", "ignored/file.txt"], "--quiet", "download contract fixture report\n"],
					[["screenshot", "body", "--screenshot-dir", "ignored/shot.png"], "--screenshot-dir", "89504e470d0a1a0a"],
				] as const) {
					for (const raw of [false, true]) await t.test(`${step[0]} ${raw ? "raw" : "stdin"} batch keeps its literal destination`, async () => {
						await rm(join(dir, path), { force: true });
						const result = await call(raw ? ["batch", step.join(" ")] : ["batch"], raw ? undefined : JSON.stringify([step]));
						assert.equal(result.isError, false, result.content[0]?.text);
						const bytes = await readFile(join(dir, path));
						assert.equal(step[0] === "screenshot" ? bytes.subarray(0, 8).toString("hex") : bytes.subarray(0, header.length).toString(), header);
						const artifact = (result.details?.artifacts as FileArtifactMetadata[])[0];
						t.diagnostic(JSON.stringify({ step, raw, nativePath: artifact?.path, requestedPath: artifact?.requestedPath, sizeBytes: bytes.length }));
						assert.equal(artifact?.requestedPath, path);
						assert.equal(artifact?.exists, true);
						await assert.rejects(stat(join(dir, "ignored")), { code: "ENOENT" });
					});
				}
				for (const flag of ["--download", "-d"]) await t.test(`wait ${flag} keeps the operand after an interleaved timeout`, async (wait) => {
					const path = `wait-${flag.slice(1)}/capture.csv`;
					const result = await call(["batch"], JSON.stringify([["click", "#delayed-anchor-download"], ["wait", flag, "--timeout", "30000", path, "ignored.csv"]]));
					const artifact = (result.details?.artifacts as FileArtifactMetadata[])[0];
					t.diagnostic(JSON.stringify({ flag, nativePath: artifact?.path, requestedPath: artifact?.requestedPath, exists: artifact?.exists }));
					assert.equal(artifact?.path, path);
					await wait.test("prepares the native retained path's parent directory", async () => {
						assert.equal((await stat(join(dir, `wait-${flag.slice(1)}`))).isDirectory(), true);
					});
					await wait.test("retains the native requested path in artifact metadata", () => assert.equal(artifact?.requestedPath, path));
					// Native 0.36 reports the requested wait path without moving the completed download there.
					assert.equal(result.isError, true);
					assert.equal(artifact?.exists, false);
					await assert.rejects(readFile(join(dir, path)), { code: "ENOENT" });
				});
				for (const raw of [false, true]) await t.test(`timeout evidence follows ${raw ? "raw argv instead of ignored stdin" : "stdin native operands"}`, async () => {
					const pdf = `timeout-${raw}.pdf`;
					const download = `-timeout-${raw}.bin`;
					const steps = [["pdf", pdf, "ignored.pdf"], ["download", "#direct-download", download, "ignored.bin"], ["pdf", "--quick", "ignored.pdf"], ["wait", "8000"]];
					const result = await call(raw ? ["batch", ...steps.map((step) => step.join(" "))] : ["batch"], JSON.stringify(raw ? [["pdf", "ignored-stdin.pdf"]] : steps), 1000);
					assert.equal(result.details?.timedOut, true, result.content[0]?.text);
					assert.equal((await readFile(join(dir, pdf))).subarray(0, 5).toString(), "%PDF-");
					assert.equal(await readFile(join(dir, download), "utf8"), "download contract fixture report\n");
					const progress = result.details?.timeoutPartialProgress as { artifacts: Array<{ exists: boolean; path: string }> };
					t.diagnostic(JSON.stringify({ raw, timeoutArtifacts: progress?.artifacts }));
					assert.deepEqual(progress?.artifacts.map(({ path, exists }) => ({ path, exists })), [pdf, download, "--quick"].map((path) => ({ path, exists: true })));
					await assert.rejects(stat(join(dir, "ignored-stdin.pdf")), { code: "ENOENT" });
				});
				for (const command of ["pdf", "screenshot"]) await t.test(`timeout retry preserves the native ${command} destination`, { skip: process.platform === "win32" }, async (retryTest) => {
					const ignored = `ignored-retry-${command}`;
					const step = command === "pdf" ? [command, "--quick", ignored] : [command, "body", "--quick", ignored];
					const path = join(dir, "--quick");
					await rm(path, { force: true });
					await symlink("missing/retry-output", path);
					// A real filesystem failure leaves this row incomplete before the later wait times out.
					const timedOut = await call(["batch"], JSON.stringify([step, ["wait", "3000"]]), 1000);
					assert.equal(timedOut.details?.timedOut, true, timedOut.content[0]?.text);
					const retry = (timedOut.details?.nextActions as AgentBrowserNextAction[]).find((action) => action.id === "retry-timeout-step");
					assert.ok(retry?.params);
					await rm(path);
					const retried = await executeRegisteredTool(h.tool, h.ctx, retry.params);
					t.diagnostic(JSON.stringify({ step, retry: retry.params, retriedError: retried.isError, retriedPaths: (retried.details?.artifacts as FileArtifactMetadata[] | undefined)?.map((artifact) => artifact.path) }));
					await retryTest.test("following nextActions writes the original path", async () => {
						assert.equal(retried.isError, false, retried.content[0]?.text);
						const bytes = await readFile(path);
						assert.equal(command === "pdf" ? bytes.subarray(0, 5).toString() : bytes.subarray(0, 8).toString("hex"), command === "pdf" ? "%PDF-" : "89504e470d0a1a0a");
						await assert.rejects(stat(join(dir, ignored)), { code: "ENOENT" });
					});
					await retryTest.test("visible retry and session-scoped action retain the same native row", () => {
						const text = timedOut.content[0]?.text ?? "";
						const payload = JSON.parse(text.split("\n").find((line) => line.startsWith("Retry failed step: "))?.slice("Retry failed step: ".length) ?? "null");
						assert.deepEqual(payload, { args: ["batch"], stdin: JSON.stringify([step]) });
						assert.deepEqual(retry.params, { args: [...prefix, "batch"], stdin: JSON.stringify([step]) });
						assert.ok(text.includes(JSON.stringify(retry.params)));
					});
				});
				await t.test("native recording reservations cover interleaved waits and literal batch paths", async (recording) => {
					const held = join(dir, "held.webm");
					const literal = join(dir, "--quick");
					await rm(literal, { force: true });
					await writeFile(held, "");
					await link(held, literal); // Keep the literal-global alias while 0.37 requires a recording extension.
					const started = await call(["record", "start", held]);
					assert.equal(started.isError, false, started.content[0]?.text);
					assert.equal((started.details?.artifacts as FileArtifactMetadata[])[0]?.status, "pending");
					for (const [index, params] of [
						{ args: [...prefix, "wait", "--download", "--timeout", "100", held] },
						{ args: [...prefix, "wait", "-d", "--timeout", "100", held] },
						{ args: [...prefix, "batch"], stdin: JSON.stringify([["pdf", "--quick", "ignored.pdf"]]) },
						{ args: [...prefix, "batch", "download #direct-download --quick ignored.bin"] },
					].entries()) await recording.test(`reserved native path rejects command ${index + 1}`, async () => {
						const blocked = await executeRegisteredTool(h.tool, h.ctx, params);
						assert.equal(blocked.details?.failureCategory, "validation-error", blocked.content[0]?.text);
						assert.match(blocked.content[0]?.text ?? "", /reserved by an active recording/);
						assert.equal(blocked.details?.exitCode, undefined);
					});
					t.diagnostic(JSON.stringify({ reservedPath: held, nativeRecordingStarted: true }));
				});
			} finally {
				const closed = await runAgentBrowserProcess({ args: ["--json", ...prefix, "close"], cwd: dir });
				assert.equal(closed.exitCode, 0, closed.stderr);
				await runExtensionEvent(h.handlers, "session_shutdown", { reason: "quit" }, h.ctx);
				assert.equal(await waitForTestPidExit(daemonPid, 10_000), true, "owned native daemon must exit");
				t.diagnostic(JSON.stringify({ session, daemonPid, closed: true }));
			}
		});
	} finally {
		await fixture.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("real upstream recording FPS preserves destinations and the intended page", { skip: !real, timeout: 180_000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "rf-"));
	const socketDir = join(dir, "s");
	await mkdir(socketDir, { mode: 0o700 });
	const fixture = await startAgentBrowserContractFixtureServer();
	const url = `${fixture.baseUrl}/contract`;
	try {
		await withPatchedEnv({ HOME: dir, USERPROFILE: dir, PI_CODING_AGENT_DIR: join(dir, "pi"), PI_AGENT_BROWSER_SOCKET_DIR: socketDir, AGENT_BROWSER_SOCKET_DIR: socketDir, AGENT_BROWSER_CONFIG: undefined, AGENT_BROWSER_NAMESPACE: undefined, AGENT_BROWSER_PROFILE: undefined, AGENT_BROWSER_RESTORE: undefined, AGENT_BROWSER_CDP: undefined, AGENT_BROWSER_AUTO_CONNECT: undefined }, async () => {
			const version = (await runAgentBrowserProcess({ args: ["--version"], cwd: dir })).stdout.match(/agent-browser (\d+)\.(\d+)\./);
			assert.ok(version);
			if (Number(version[1]) === 0 && Number(version[2]) < 37) { t.skip("Recording FPS requires native 0.37 or newer; older recording controls run separately."); return; }
			const h = createExtensionHarness({ cwd: dir, sessionId: randomUUID() });
			await runExtensionEvent(h.handlers, "session_start", { reason: "new" }, h.ctx);
			const call = (args: string[], stdin?: string, outputPath?: string) => executeRegisteredTool(h.tool, h.ctx, { args, stdin, outputPath });
			let daemonPid: number | undefined;
			try {
				const opened = await call(["open", url]);
				assert.equal(opened.isError, false, opened.content[0]?.text);
				const sessionName = opened.details?.sessionName;
				assert.ok(typeof sessionName === "string");
				daemonPid = Number(await readFile(join(socketDir, `${sessionName}.pid`), "utf8"));
				const direct = (args: string[]) => runAgentBrowserProcess({ args: ["--json", "--session", sessionName, ...args], cwd: dir });
				for (const mode of ["direct", "stdin", "raw"]) await t.test(`${mode} FPS outputPath collision stops before native recording`, async () => {
					const path = join(dir, `preflight-${mode}.webm`);
					const row = ["record", "start", "--fps", "12", path];
					let reached = false;
					try {
						const result = await call(mode === "direct" ? row : mode === "raw" ? ["batch", row.join(" ")] : ["batch"], mode === "stdin" ? JSON.stringify([row]) : undefined, path);
						reached = result.details?.agentBrowserStarted === true;
						t.diagnostic(JSON.stringify({ mode, nativeReached: reached, outputFile: result.details?.outputFile, error: result.content[0]?.text }));
						assert.equal(result.details?.failureCategory, "validation-error");
						assert.equal(reached, false, "a post-write outputPath guard is not early artifact protection");
						await assert.rejects(stat(path), { code: "ENOENT" });
					} finally {
						if (reached) {
							const stopped = await call(["record", "stop"]);
							if (stopped.isError) await call(["record", "stop"]); // Retire a native failed-encoder take during RED too.
						}
					}
				});
				for (const subcommand of ["start", "restart"]) {
					assert.equal((await call(["open", url])).isError, false);
					assert.equal((await direct(["tab", "new", "about:blank"])).exitCode, 0);
					const recovered = await call(["snapshot", "-i"]);
					assert.equal((recovered.details?.sessionTabCorrection as { targetUrl?: string })?.targetUrl, url);
					const snapshot = await call(["snapshot", "-i"]);
					const refs = (snapshot.details?.refSnapshot as { refs: Record<string, { name: string }> }).refs;
					const ref = Object.entries(refs).find(([, entry]) => entry.name === "Go to next fixture page")?.[0];
					assert.ok(ref);
					if (subcommand === "start") {
						const blocked = await call(["batch"], JSON.stringify([["record", "start", join(dir, "blocked.webm")], ["get", "text", `@${ref}`]]));
						assert.equal(blocked.details?.failureCategory, "stale-ref", "keep the older-native start-then-ref latch");
						assert.notEqual(blocked.details?.agentBrowserStarted, true);
					}
					assert.equal((await direct(["tab", "new", `${fixture.baseUrl}/next`])).exitCode, 0);
					const path = join(dir, `${subcommand}.webm`);
					const args = ["record", subcommand, "--fps", "12", path];
					const recording = await call(args);
					assert.equal(recording.isError, false, recording.content[0]?.text);
					const observedUrl = JSON.parse((await direct(["get", "url"])).stdout).data.url;
					await t.test(`${subcommand} FPS retains the declared native destination`, () => {
						assert.equal((recording.details?.artifacts as FileArtifactMetadata[]).find((artifact) => artifact.subcommand === subcommand)?.requestedPath, path);
						assert.deepEqual((recording.details?.effectiveArgs as string[]).slice(-args.length), args);
					});
					await t.test(`${subcommand} FPS records the pinned page rather than the drifted tab`, () => assert.equal(observedUrl, url));
					await t.test(`${subcommand} FPS ref policy is conservative rather than false page-change evidence`, async () => {
						const invalidation = recording.details?.refSnapshotInvalidation as { summary?: string } | undefined;
						const read = await call(["get", "text", `@${ref}`]);
						if (subcommand === "start") {
							assert.equal(read.details?.failureCategory, "stale-ref");
							assert.match(invalidation?.summary ?? "", /conservatively/);
						} else {
							assert.equal(invalidation, undefined);
							assert.equal(read.isError, false, read.content[0]?.text);
						}
						assert.doesNotMatch(`${recording.content[0]?.text}\n${invalidation?.summary}`, /fresh active page|replaced or navigated/);
					});
					const began = Date.now();
					assert.equal((await direct(["wait", "12000"])).exitCode, 0);
					t.diagnostic(JSON.stringify({ subcommand, observedUrl, captureHoldMs: Date.now() - began, note: "Explicit 12s fixture capture; short/cold native Ubuntu captures can fail before encoding." }));
					const stopped = await call(["record", "stop"]);
					assert.equal(stopped.isError, false, stopped.content[0]?.text);
					assert.equal((await readFile(path)).subarray(0, 4).toString("hex"), "1a45dfa3");
					assert.equal((stopped.details?.data as { fps: number }).fps, 12);
				}
			} finally {
				await call(["close"]);
				await runExtensionEvent(h.handlers, "session_shutdown", { reason: "quit" }, h.ctx);
				assert.equal(await waitForTestPidExit(daemonPid, 10_000), true, "owned native daemon must exit");
			}
		});
	} finally { await fixture.close(); await rm(dir, { recursive: true, force: true }); }
});

test("real upstream batch argv and ref fidelity for pinned and unpinned registered tools", { skip: !real, timeout: 180_000 }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "bf-"));
	const socketDir = join(dir, "s");
	await mkdir(socketDir, { mode: 0o700 });
	const browserBin = join(dir, "bin");
	await mkdir(browserBin);
	if (process.platform === "linux" && process.env.AGENT_BROWSER_EXECUTABLE_PATH) {
		await symlink(process.env.AGENT_BROWSER_EXECUTABLE_PATH, join(browserBin, "google-chrome"));
	}
	const fixture = await startAgentBrowserContractFixtureServer();
	const url = `${fixture.baseUrl}/contract`;
	const target = { title: "Agent Browser Contract Fixture", url };
	try {
		await withPatchedEnv({
			HOME: dir, USERPROFILE: dir, PI_CODING_AGENT_DIR: join(dir, "pi"),
			PI_AGENT_BROWSER_SOCKET_DIR: socketDir, AGENT_BROWSER_SOCKET_DIR: socketDir,
			AGENT_BROWSER_CONFIG: undefined, AGENT_BROWSER_NAMESPACE: undefined,
			AGENT_BROWSER_PROFILE: undefined, AGENT_BROWSER_RESTORE: undefined,
			AGENT_BROWSER_CDP: undefined, AGENT_BROWSER_AUTO_CONNECT: undefined,
			// Native browser discovery avoids passive launch flags reconfiguring the CDP fixture.
			AGENT_BROWSER_EXECUTABLE_PATH: undefined,
			PATH: `${browserBin}${delimiter}${process.env.PATH}`,
		}, async () => {
			for (const pinned of [false, true]) {
				const sessionName = `bf-${randomUUID().slice(0, 8)}`;
				const namespace = `bf-${randomUUID().slice(0, 8)}`;
				const prefix = ["--namespace", namespace, "--session", sessionName];
				const extraSessions: string[] = [];
				const direct = (args: string[], stdin?: string) => runAgentBrowserProcess({ args: ["--json", ...prefix, ...args], cwd: dir, stdin });
				const opened = await direct(["open", url]);
				assert.equal(opened.exitCode, 0, opened.stderr);
				const makeHarness = async (extraDetails: Record<string, unknown> = {}) => {
					const h = createExtensionHarness({ cwd: dir, sessionId: randomUUID(), branch: pinned ? [createToolBranchEntry({ details: { args: [...prefix, "open", url], command: "open", namespace, sessionName, sessionTabTarget: target, ...extraDetails }, isError: false })] : [] });
					await runExtensionEvent(h.handlers, "session_start", { reason: pinned ? "resume" : "new" }, h.ctx);
					return h;
				};
				let h = await makeHarness();
				if (pinned) await direct(["tab", "new", `${fixture.baseUrl}/next`]);
				const call = (args: string[], stdin?: string) => executeRegisteredTool(h.tool, h.ctx, { args: [...prefix, ...args], stdin });
				const keepActiveTab = async () => {
					const tabs = JSON.parse((await direct(["tab", "list"])).stdout).data.tabs;
					for (const tab of tabs) if (!tab.active) {
						const closed = await direct(["tab", "close", tab.tabId]);
						assert.equal(closed.exitCode, 0, JSON.stringify(closed));
					}
				};
				const label = pinned ? "pinned" : "unpinned";
				try {
					await t.test(`${label}: same-tab ref spellings remain usable and text stays literal`, async () => {
						const snapshot = await call(["snapshot", "-i"]);
						assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
						const refs = (snapshot.details?.refSnapshot as { refs: Record<string, { name: string }> }).refs;
						const id = Object.entries(refs).find(([, ref]) => ref.name === "Name")?.[0];
						assert.ok(id, JSON.stringify(refs));
						for (const ref of [`@${id}`, id, `ref=${id}`]) {
							const filled = await call(["fill", ref, "--bail"]);
							assert.equal(filled.isError, false, JSON.stringify(filled));
							assert.deepEqual(filled.details?.effectiveArgs, ["--json", ...prefix, "fill", ref, "--bail"]);
						}
						for (const text of ["@e999", "e999", "ref=e999", "--bail=true"]) {
							assert.equal((await call(["fill", "#name-input", text])).isError, false);
							const value = await direct(["get", "value", "#name-input"]);
							assert.equal(JSON.parse(value.stdout).data.value, text);
						}
					});
					await t.test(`${label}: mixed failures retain rows, failure category and native Pi hook`, async () => {
						for (const bail of [false, true]) {
							if (pinned) assert.equal((await direct(["tab", "new", `${fixture.baseUrl}/next`])).exitCode, 0);
							const steps = [["fill", "#name-input", "before"], ["not-a-command"], ["fill", "#name-input", "after"]];
							const result = await call(["batch", ...(bail ? ["--bail"] : [])], JSON.stringify(steps));
							assert.equal(result.isError, true, JSON.stringify(result));
							assert.equal(result.details?.resultCategory, "failure");
							const rows = result.details?.batchSteps as Array<{ index: number; success: boolean }>;
							assert.equal(rows?.length, bail ? 2 : 3, JSON.stringify(result));
							assert.deepEqual(rows.map((row) => row.success), bail ? [true, false] : [true, false, true]);
							assert.equal((result.details?.batchFailure as { failedStep: { index: number } }).failedStep.index, 1);
							assert.match(result.content[0]?.text ?? "", /Batch failed:/);
							const patches = await runExtensionEventResults<{ isError?: boolean }>(h.handlers, "tool_result", { toolName: "agent_browser", toolCallId: "fixture", input: { args: [...prefix, "batch"] }, ...result, isError: false }, h.ctx);
							assert.equal(patches[0]?.isError, true);
							assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, bail ? "before" : "after");
						}
					});
					await t.test(`${label}: global headers and explicit native pin preferences survive dispatch`, async () => {
						if (pinned) assert.equal((await direct(["tab", "new", `${fixture.baseUrl}/next`])).exitCode, 0);
						const args = ["--headers", '{"x-fixture":"batch-fidelity"}', "--no-pin-tab", "batch", "--bail"];
						const result = await call(args, JSON.stringify([["open", `${fixture.baseUrl}/headers`], ["get", "value", "#header-value"]]));
						assert.equal(result.isError, false, JSON.stringify(result));
						assert.deepEqual(result.details?.effectiveArgs, ["--json", ...prefix, ...args.map((arg) => arg.startsWith("{") ? "[REDACTED]" : arg)]);
						assert.equal(JSON.parse((await direct(["get", "value", "#header-value"])).stdout).data.value, "present");
						assert.equal((await call(["open", url])).isError, false);
					});
					await t.test(`${label}: raw argv wins over stdin and command timeout stays native`, async () => {
						const result = await call(["batch", "fill '#name-input' 'raw text'"], '[["fill","#name-input","ignored"]]');
						assert.equal(result.isError, false, JSON.stringify(result));
						assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "raw text");
						const misplacedTimeout = await call(["--timeout", "50", "fill", "#name-input", "must-not-run"]);
						assert.equal(misplacedTimeout.isError, true, JSON.stringify(misplacedTimeout));
						assert.deepEqual(misplacedTimeout.details?.effectiveArgs, ["--json", ...prefix, "--timeout", "50", "fill", "#name-input", "must-not-run"]);
						assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "raw text");
						const wait = await call(["wait", "--text", "not present in fixture", "--timeout", "50"]);
						assert.equal(wait.isError, true);
						assert.deepEqual(wait.details?.effectiveArgs, ["--json", ...prefix, "wait", "--text", "not present in fixture", "--timeout", "50"]);
						const bad = await call(["batch", "--bail=true"], '[["fill","#name-input","ignored"]]');
						assert.match(bad.content[0]?.text ?? "", /exact.*--bail.*stdin.*ignored/i);
						assert.equal(bad.details?.exitCode, undefined);
					});
					await t.test(`${label}: stale spellings reject before upstream and key/mouse literals are not refs`, async () => {
						await call(["snapshot", "-i"]);
						for (const ref of ["@e999", "e999", "ref=e999"]) {
							const stale = await call(["fill", ref, "wrong"]);
							assert.equal(stale.details?.failureCategory, "stale-ref", JSON.stringify(stale));
							assert.equal(stale.details?.exitCode, undefined);
						}
						await call(["focus", "#name-input"]);
						for (const args of [["keyboard", "inserttext", "@e999"], ["press", "@e999"], ["key", "@e999"], ["mouse", "wheel", "@e999"]]) {
							const result = await call(args);
							assert.notEqual(result.details?.failureCategory, "stale-ref", JSON.stringify(result));
							assert.equal(result.details?.agentBrowserStarted, true, JSON.stringify(result));
						}
					});
					await t.test(`${label}: CSS-only selectors remain literal while ref consumers stay guarded`, async (css) => {
						assert.equal((await call(["open", url])).isError, false);
						assert.equal((await direct(["eval", "document.body.insertAdjacentHTML('beforeend', '<e999><p>Literal subtree</p></e999>')"])).exitCode, 0);
						assert.equal((await call(["snapshot", "-i"])).isError, false);
						await css.test("get count treats bare eN as a CSS tag", async () => {
							for (const [selector, count] of [["e999", 1], ["e998", 0]] as const) {
								const native = await direct(["get", "count", selector]);
								assert.equal(native.exitCode, 0, native.stderr);
								assert.equal(JSON.parse(native.stdout).data.count, count);
								const counted = await call(["get", "count", selector]);
								assert.equal(counted.isError, false, JSON.stringify(counted));
								assert.equal((counted.details?.data as { count: number }).count, count);
							}
						});
						await css.test("diff snapshot treats bare eN as a CSS subtree", async () => {
							const args = ["diff", "snapshot", "--selector", "e999"];
							const native = await direct(args);
							assert.equal(native.exitCode, 0, native.stderr);
							assert.match(JSON.parse(native.stdout).data.diff, /Literal subtree/);
							const compared = await call(args);
							assert.equal(compared.isError, false, JSON.stringify(compared));
							assert.match((compared.details?.data as { diff: string }).diff, /Literal subtree/);
						});
						await css.test("ref-resolving getters and diff screenshot still reject absent refs", async () => {
							assert.equal((await call(["snapshot", "-i"])).isError, false);
							for (const args of [
								...["text", "html", "value", "box", "styles"].map((getter) => ["get", getter, "e999"]),
								["get", "attr", "e999", "id"],
								["diff", "screenshot", "--baseline", join(dir, "unused.png"), "--selector", "e999"],
							]) {
								const stale = await call(args);
								assert.equal(stale.details?.failureCategory, "stale-ref", JSON.stringify(stale));
								assert.equal(stale.details?.exitCode, undefined);
							}
						});
					});
					if (pinned) await t.test("pinned: same-URL tabs retain the known titled target", async () => {
						await keepActiveTab();
						await direct(["open", url]);
						const originalTabs = JSON.parse((await direct(["tab", "list"])).stdout).data.tabs;
						const originalTab = originalTabs.find((tab: { active: boolean }) => tab.active);
						const original = originalTab.tabId;
						h = await makeHarness({ sessionTabTarget: { title: originalTab.title, url } });
						await direct(["tab", "new", url]);
						await direct(["eval", "document.title = 'Different tab'"]);
						const duplicateTabs = JSON.parse((await direct(["tab", "list"])).stdout).data.tabs;
						const duplicate = duplicateTabs.find((tab: { active: boolean }) => tab.active).tabId;
						await direct(["tab", duplicate]); // Native selection refreshes the cached tab title.
						assert.equal(JSON.parse((await direct(["tab", "list"])).stdout).data.tabs.find((tab: { tabId: string }) => tab.tabId === duplicate).title, "Different tab");
						const filled = await call(["fill", "#name-input", "intended"]);
						assert.equal(filled.isError, false, JSON.stringify(filled));
						assert.equal((filled.details?.sessionTabCorrection as { selectedTab: string } | undefined)?.selectedTab, original, JSON.stringify({ original, duplicate, originalTabs, duplicateTabs, filled }));
						await direct(["tab", duplicate]);
						assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "");
						await direct(["tab", original]);
					});
					if (pinned) await t.test("pinned: actual tab switch refreshes refs before same-page actions", async () => {
						const snapshot = await call(["snapshot", "-i"]);
						const refs = (snapshot.details?.refSnapshot as { refs: Record<string, { name: string }> }).refs;
						const id = Object.entries(refs).find(([, ref]) => ref.name === "Name")?.[0];
						assert.ok(id);
						await direct(["tab", "new", `${fixture.baseUrl}/next`]);
						const filled = await call(["fill", `ref=${id}`, "switched"]);
						assert.equal(filled.isError, false, JSON.stringify(filled));
						assert.ok(filled.details?.sessionTabCorrection);
						assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "switched");
					});
					if (pinned && process.platform !== "win32") await t.test("pinned: native selection failure and post-selection mismatch execute zero user steps", async () => {
						const binary = execFileSync("which", ["agent-browser"], { encoding: "utf8" }).trim();
						const shimDir = join(dir, "shim");
						await mkdir(shimDir);
						const modeFile = join(shimDir, "fault");
						await writeFakeAgentBrowserBinary(shimDir, `const fs = require('node:fs'); const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2), input = fs.readFileSync(0, 'utf8'), i = args.indexOf('tab');
const run = (a) => spawnSync(${JSON.stringify(binary)}, a, { input, encoding: 'utf8' });
const fault = fs.existsSync(${JSON.stringify(modeFile)}) ? fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8') : '';
if (fault && i >= 0 && args[i+1] !== 'list' && args[i+1] !== 'new' && args[i+1] !== 'close') {
 fs.unlinkSync(${JSON.stringify(modeFile)});
 if (fault === 'gone') run([...args.slice(0, i), 'tab', 'close', args[i+1]]);
}
const result = run(args);
if (fault === 'mismatch' && i >= 0 && args[i+1] !== 'list') run([...args.slice(0,i), 'tab', 'new', ${JSON.stringify(`${fixture.baseUrl}/next`)}]);
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);`);
						for (const fault of ["mismatch", "gone"]) {
							await direct(["open", url]);
							h = await makeHarness();
							await direct(["tab", "new", `${fixture.baseUrl}/next`]);
							await writeFile(modeFile, fault);
							await withPatchedEnv({ PATH: `${shimDir}:${process.env.PATH}` }, async () => {
								const blocked = await call(["batch"], '[["eval","document.body.dataset.wrong=1"]]');
								assert.equal(blocked.details?.failureCategory, "tab-drift", JSON.stringify(blocked));
								assert.equal(blocked.details?.exitCode, undefined);
							});
							assert.equal(JSON.parse((await direct(["eval", "document.body.dataset.wrong || 'untouched'"])).stdout).data.result, "untouched");
						}
						await direct(["open", url]);
					});
					if (pinned) await t.test("pinned: explicit connect replaces the target and failed recovery preserves batch flow", async () => {
						assert.equal((await direct(["close"])).exitCode, 0);
						const sourceSession = `cdp-${randomUUID().slice(0, 8)}`;
						extraSessions.push(sourceSession);
						const source = (args: string[]) => runAgentBrowserProcess({ args: ["--json", "--namespace", namespace, "--session", sourceSession, ...args], cwd: dir });
						const openedSource = await source(["open", url]);
						assert.equal(openedSource.exitCode, 0, JSON.stringify(openedSource));
						const endpoint = JSON.parse((await source(["get", "cdp-url"])).stdout).data.cdpUrl;
						assert.equal(typeof endpoint, "string");
						h = await makeHarness({ sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` } });
						const connected = await call(["connect", endpoint]);
						assert.equal(connected.isError, false, JSON.stringify(connected));
						assert.equal(connected.details?.refSnapshot, undefined);
						assert.equal((await call(["get", "url"])).isError, false);
						const attachedTabs = await call(["tab", "list"]);
						const attachedTab = (attachedTabs.details?.data as { tabs: Array<{ tabId: string; url: string }> }).tabs.find((tab) => tab.url === url);
						assert.ok(attachedTab, JSON.stringify(attachedTabs));
						assert.equal((await call(["tab", attachedTab.tabId])).isError, false);
						assert.equal((await call(["snapshot", "-i"])).isError, false);
						const filledConnected = await call(["fill", "#name-input", "connected"]);
						assert.equal(filledConnected.isError, false, JSON.stringify(filledConnected));
						assert.equal(JSON.parse((await source(["get", "value", "#name-input"])).stdout).data.value, "connected");
						const unsafe = await call(["batch"], JSON.stringify([["connect", "1"], ["fill", "#name-input", "must-not-run"]]));
						assert.match(String(unsafe.details?.validationError), /unverified|batch --bail/);
						assert.equal(unsafe.details?.exitCode, undefined);
						h = await makeHarness({ sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` } });
						const failed = await call(["batch"], JSON.stringify([["connect", "1"], ["get", "url"]]));
						assert.equal(failed.isError, true);
						assert.deepEqual((failed.details?.batchSteps as Array<{ success: boolean }>).map((row) => row.success), [false, true]);
					});
					if (pinned) await t.test("pinned: explicit state replay verifies the new page without inventing fresh refs", async () => {
						await direct(["open", `${fixture.baseUrl}/next`]);
						const statePath = join(dir, "fixture-state.json");
						await writeFile(statePath, JSON.stringify({ cookies: [], origins: [{ origin: fixture.baseUrl, localStorage: [{ name: "fidelity", value: "loaded" }] }] }));
						h = await makeHarness({ sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` } });
						const loaded = await call(["state", "load", statePath]);
						assert.equal(loaded.isError, false, JSON.stringify(loaded));
						assert.equal(loaded.details?.refSnapshot, undefined);
						assert.equal((await call(["get", "url"])).isError, false);
						assert.equal(JSON.parse((await direct(["eval", "localStorage.getItem('fidelity')"])).stdout).data.result, "loaded");
						const unsafe = await call(["batch"], JSON.stringify([["state", "load", `${statePath}.missing`], ["fill", "#name-input", "must-not-run"]]));
						assert.match(String(unsafe.details?.validationError), /unverified|batch --bail/);
						assert.equal(unsafe.details?.exitCode, undefined);
						h = await makeHarness({ sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` } });
						const failed = await call(["batch"], JSON.stringify([["state", "load", `${statePath}.missing`], ["get", "url"]]));
						assert.equal(failed.isError, true);
						assert.deepEqual((failed.details?.batchSteps as Array<{ success: boolean }>).map((row) => row.success), [false, true]);
						h = await makeHarness({ sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` } });
						const replay = await call(["batch", "--bail"], JSON.stringify([["state", "load", statePath], ["get", "url"], ["snapshot", "-i"]]));
						assert.equal(replay.isError, false, JSON.stringify(replay));
						assert.ok(replay.details?.refSnapshot);
					});
					if (pinned) await t.test("pinned: sessionless commands do not require the prior page", async (local) => {
						h = await makeHarness({ sessionTabTarget: { url: `${fixture.baseUrl}/missing-target` } });
						const skills = await call(["skills", "list"]);
						assert.equal(skills.isError, false, JSON.stringify(skills));
						assert.deepEqual(skills.details?.effectiveArgs, ["--json", ...prefix, "skills", "list"]);
						for (const readOnly of [undefined, ["tab", "list"], ["tab"], ["get", "url"]]) {
							await local.test(`then ${readOnly?.join(" ") ?? "direct fill"} preserves the intended tab`, async () => {
								await keepActiveTab();
								assert.equal((await direct(["open", url])).exitCode, 0);
								const intended = JSON.parse((await direct(["tab", "list"])).stdout).data.tabs.find((tab: { active: boolean }) => tab.active).tabId;
								assert.equal((await direct(["tab", "new", `${url}?other-tab`])).exitCode, 0);
								const other = JSON.parse((await direct(["tab", "list"])).stdout).data.tabs.find((tab: { active: boolean }) => tab.active).tabId;
								assert.equal((await direct(["fill", "#name-input", "untouched"])).exitCode, 0);
								h = await makeHarness();
								assert.equal((await call(["skills", "list"])).isError, false);
								const fill = ["fill", "#name-input", "intended"];
								const filled = readOnly ? await call(["batch"], JSON.stringify([readOnly, fill])) : await call(fill);
								assert.equal(filled.isError, false, JSON.stringify(filled));
								assert.equal((await direct(["tab", other])).exitCode, 0);
								assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "untouched", "local success must not let a later action mutate the other tab");
								assert.equal((await direct(["tab", intended])).exitCode, 0);
								assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "intended");
							});
						}
						await local.test("auth metadata cannot replace the intended page for a later action", async () => {
							await keepActiveTab();
							assert.equal((await direct(["open", url])).exitCode, 0);
							const intended = JSON.parse((await direct(["tab", "list"])).stdout).data.tabs.find((tab: { active: boolean }) => tab.active).tabId;
							assert.equal((await direct(["tab", "new", `${url}?other-tab`])).exitCode, 0);
							const other = JSON.parse((await direct(["tab", "list"])).stdout).data.tabs.find((tab: { active: boolean }) => tab.active).tabId;
							assert.equal((await direct(["fill", "#name-input", "untouched"])).exitCode, 0);
							h = await makeHarness();
							const saved = await call(["auth", "save", "fixture", "--url", `${fixture.baseUrl}/auth-metadata`, "--username", "synthetic-user", "--password-stdin"], "synthetic-password");
							assert.equal(saved.isError, false, JSON.stringify(saved));
							const filled = await call(["fill", "#name-input", "intended"]);
							assert.equal(filled.isError, false, JSON.stringify(filled));
							assert.equal((await direct(["tab", other])).exitCode, 0);
							assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "untouched", "local auth metadata must not let a later action mutate the other tab");
							assert.equal((await direct(["tab", intended])).exitCode, 0);
							assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "intended");
							assert.equal((saved.details?.sessionTabTarget as { url: string }).url, url);
						});
						await local.test("explicit get url chooses the live page for subsequent content", async () => {
							await keepActiveTab();
							assert.equal((await direct(["open", `${url}?chosen-page`])).exitCode, 0);
							h = await makeHarness();
							assert.equal((await call(["skills", "list"])).isError, false);
							const verified = await call(["get", "url"]);
							assert.equal(verified.isError, false, JSON.stringify(verified));
							assert.equal((verified.details?.sessionTabTarget as { url: string }).url, `${url}?chosen-page`);
							assert.equal((await call(["fill", "#name-input", "chosen"])).isError, false);
							assert.equal(JSON.parse((await direct(["get", "value", "#name-input"])).stdout).data.value, "chosen");
						});
					});
					if (pinned) await t.test("pinned: missing intended tab runs zero user steps", async () => {
						await keepActiveTab();
						h = await makeHarness();
						const changedPage = await direct(["open", `${fixture.baseUrl}/next`]);
						assert.equal(changedPage.exitCode, 0, JSON.stringify(changedPage));
						const blocked = await call(["batch"], '[["eval","document.body.dataset.wrong=1"]]');
						assert.equal(blocked.isError, true, JSON.stringify(blocked));
						assert.equal(blocked.details?.failureCategory, "tab-drift");
						assert.equal(blocked.details?.exitCode, undefined);
						assert.equal(JSON.parse((await direct(["eval", "document.body.dataset.wrong || 'untouched'"])).stdout).data.result, "untouched");
						const recovered = await call(["batch", "--bail"], JSON.stringify([["tab", "new", url], ["get", "url"], ["snapshot", "-i"]]));
						assert.equal(recovered.isError, false, JSON.stringify(recovered));
					});
				} finally {
					assert.equal((await direct(["close"])).exitCode, 0);
					for (const extraSession of extraSessions) await runAgentBrowserProcess({ args: ["--json", "--namespace", namespace, "--session", extraSession, "close"], cwd: dir });
					await runExtensionEvent(h.handlers, "session_shutdown", { reason: "quit" }, h.ctx);
				}
			}
		});
	} finally {
		await fixture.close();
		await rm(dir, { force: true, recursive: true });
	}
});
