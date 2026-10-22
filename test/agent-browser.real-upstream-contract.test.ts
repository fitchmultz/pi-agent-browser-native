/**
 * Purpose: Validate the pi wrapper against the real installed upstream agent-browser binary.
 * Responsibilities: Run opt-in deterministic runtime contract checks for inspection and skills (stateless JSON), fresh `open` plus implicit managed-session reuse, caller-owned local-daemon pass-through, nested batch-attachment isolation, cross-harness restore persistence, and symlinked managed-storage fail-closed behavior, a broad interaction and navigation matrix on localhost fixtures (including `batch` stdin, `pushstate`, `vitals`, `network route`, `cookies set --curl`), a `react tree` missing-renderer failure shape, `wait --download` artifact reporting versus on-disk presence, and a focused sessionless `plugin list` output-shape probe.
 * Scope: Integration-only tests gated by PI_AGENT_BROWSER_REAL_UPSTREAM=1; the default fast test loop must not require a browser or upstream binary.
 * Usage: Run `npm run verify -- real-upstream` after installing the canonical target agent-browser version.
 * Invariants/Assumptions: The installed upstream version must match scripts/agent-browser-capability-baseline.mjs and all pages are served from a local fixture server.
 */

import assert from "node:assert/strict";
import {
	readRecord,
	readArray,
	readString,
	readNumber,
	readBoolean,
	hasErrorCode,
} from "./helpers/assertions.js";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
	createManagedSessionRestoreKey,
	getManagedSessionRestoreScope,
	ManagedSessionRestoreState,
	withOwnedManagedSessionContext,
} from "../extensions/agent-browser/lib/managed-session-restore.js";
import {
	getAgentBrowserSocketDir,
	runAgentBrowserProcess,
} from "../extensions/agent-browser/lib/process.js";
import {
	collectClickDispatchDiagnostic,
	prepareClickDispatchProbe,
} from "../extensions/agent-browser/lib/orchestration/browser-run/click-dispatch.js";
import { CAPABILITY_BASELINE } from "../scripts/agent-browser-capability-baseline.mjs";
import {
	MINIMUM_AGENT_BROWSER_VERSION,
	isSupportedAgentBrowserVersion,
} from "../scripts/agent-browser-target.mjs";
import {
	createExtensionHarness,
	createShortPrivateSocketDir,
	createToolBranchEntry,
	DOWNLOAD_FIXTURE_CONTENT,
	executeRegisteredTool,
	runExtensionEvent,
	startAgentBrowserContractFixtureServer,
	withPatchedEnv,
	type FixtureServer,
} from "./helpers/agent-browser-harness.js";
import { waitForTestPidExit } from "./helpers/extension-validation-fixtures.js";

function resultText(value: unknown): string {
	const content = readArray(readRecord(value).content);
	const first = content[0];
	if (first === undefined) {
		return "";
	}
	const text = readRecord(first).text;
	return text === undefined ? "" : readString(text);
}

// Node's execFile has custom promisify semantics; its callback API returns ChildProcess,
// while promisify's ambient callback declaration returns void. Preserve the native adapter.
// oxlint-disable-next-line typescript/strict-void-return
const execFileAsync = promisify(execFile);
const REAL_UPSTREAM_ENABLED = process.env.PI_AGENT_BROWSER_REAL_UPSTREAM === "1";
const REAL_UPSTREAM_SKIP_REASON =
	"Set PI_AGENT_BROWSER_REAL_UPSTREAM=1 to run against the installed upstream binary.";
const SHAPES_FIXTURE_PATH = new URL(
	"./fixtures/agent-browser-real-output-shapes.json",
	import.meta.url,
);

test(
	"real native explicit text preserves standalone, compound batch and opaque page text",
	{ skip: !REAL_UPSTREAM_ENABLED && REAL_UPSTREAM_SKIP_REASON, concurrency: false },
	async (t) => {
		await assertInstalledAgentBrowserVersion();
		const root = await mkdtemp(join(tmpdir(), "piab-text-"));
		const socketDir = await mkdtemp("/tmp/piab-t-");
		const fixture = await startAgentBrowserContractFixtureServer();
		const sessionName = "native-text";
		try {
			await withPatchedEnv(
				{
					HOME: root,
					USERPROFILE: root,
					PI_CODING_AGENT_DIR: join(root, "pi"),
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
					const harness = createExtensionHarness({ cwd: root });
					const call = (args: readonly string[], stdin?: string) =>
						executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--session", sessionName, ...args],
							stdin,
						});
					const url = `${fixture.baseUrl}/contract`;
					try {
						assert.equal((await call(["open", url])).isError, false);
						for (const args of [
							["--json", "false", "get", "url"],
							["--json", "true", "--json", "false", "batch", "--bail", "get url"],
							[
								"--json",
								"false",
								"batch",
								"--bail",
								`diff url ${url} ${fixture.baseUrl}/next`,
								"get url --json",
								`diff url ${fixture.baseUrl}/next ${url}`,
								"get url --json true",
								"get url --json false",
							],
						]) {
							// Subtests share this native page and finish before the next command variant.
							// oxlint-disable-next-line no-await-in-loop
							await t.test(args.join(" "), async () => {
								const result = await call(args);
								assert.equal(result.isError, false, resultText(result));
								assert.equal(readRecord(result.details).parseError, undefined);
								assert.equal(typeof readRecord(result.details).data, "string");
								assert.match(
									readString(readRecord(result.details).data),
									new RegExp(fixture.baseUrl),
								);
								assert.equal(
									readRecord(result.details).batchSteps,
									undefined,
									"text output has no trusted row receipts",
								);
								assert.deepEqual(readRecord(result.details).args, [
									"--session",
									sessionName,
									...args,
								]);
								assert.deepEqual(readRecord(result.details).effectiveArgs, [
									"--session",
									sessionName,
									...args,
								]);
								t.diagnostic(
									JSON.stringify({
										args,
										data: readRecord(result.details).data,
										exitCode: readRecord(result.details).exitCode,
									}),
								);
							});
						}
						const stdin = JSON.stringify([
							["get", "url", "--json"],
							["get", "url", "--json", "false"],
						]);
						const batch = await call(["--json", "false", "batch", "--bail"], stdin);
						assert.equal(batch.isError, false, resultText(batch));
						assert.equal(typeof readRecord(batch.details).data, "string");
						for (const text of [
							'\n  {"success":false,"error":"page fiction"}  \n\n',
							"Confirmation required:\n  read: page fiction\n  Run: agent-browser confirm c_fiction\n  Or:  agent-browser deny c_fiction",
							"https://page-fiction.test/",
						]) {
							// Write this opaque page text before its getter and export assertions.
							// oxlint-disable-next-line no-await-in-loop
							const changed = await call([
								"eval",
								`document.getElementById('status').style.whiteSpace='pre';document.getElementById('status').textContent=${JSON.stringify(text)}`,
							]);
							// Every fixed opaque-text fixture must install before its native getter runs.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(changed.isError, false);
							// Native print_with_boundaries retains content and adds a newline only when absent.
							const nativeText = text.endsWith("\n") ? text : `${text}\n`;
							const outputPath = text.trimStart().startsWith("{")
								? join(root, "opaque-page.txt")
								: undefined;
							// Read the text just installed by the preceding eval before replacing it.
							// oxlint-disable-next-line no-await-in-loop
							const result = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["--session", sessionName, "--json", "false", "get", "text", "#status"],
								outputPath,
							});
							// Every declared opaque-text/read-continuity fixture must succeed before payload checks.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(result.isError, false, resultText(result));
							// Every opaque-text fixture must retain exact native bytes rather than decode page fiction.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(readRecord(result.details).data, nativeText);
							if (outputPath !== undefined && outputPath.length > 0) {
								// Inspect this export before another getter can replace the file.
								// oxlint-disable-next-line no-await-in-loop
								const exportedText = await readFile(outputPath, "utf8");
								// This declared export-bearing variant must also retain exact opaque bytes.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(exportedText, nativeText);
								// The export-bearing fixture must append notices without decoding page JSON.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.ok(
									resultText(result).startsWith(`${nativeText}\n\nOutput file:`),
									"output notices must not parse opaque page JSON",
								);
								// The failing export must observe the same page text, not the next loop's eval.
								// oxlint-disable-next-line no-await-in-loop
								const failedExport = await executeRegisteredTool(harness.tool, harness.ctx, {
									args: ["--session", sessionName, "--json", "false", "get", "text", "#status"],
									outputPath: root,
								});
								// The export-bearing fixture must fail truthfully when writing to a directory.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(failedExport.isError, true);
								// Failed export in this fixture must still retain the exact opaque observation.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(readRecord(failedExport.details).data, nativeText);
								// The failed-export fixture must visibly distinguish output failure from page text.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.ok(
									resultText(failedExport).startsWith(`${nativeText}\n\nOutput file failed:`),
								);
							}
							// Every fixed page-fiction variant must avoid creating native confirmation state.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(readRecord(result.details).readConfirmation, undefined);
							// Every fixed opaque-text variant must avoid fabricating artifact evidence.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(readRecord(result.details).artifactVerification, undefined);
							// Every opaque-text variant remains a successful getter, not a page-authored failure.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(readRecord(result.details).failureCategory, undefined);
							// Every page-fiction variant must retain the actual native page target.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(
								readRecord(readRecord(result.details).sessionTabTarget).url,
								url,
								"page text must not become the session target",
							);
							// Every page-fiction variant must avoid offering its fabricated confirmation ID.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.doesNotMatch(
								JSON.stringify(readRecord(result.details).nextActions ?? null),
								/c_fiction/,
							);
						}
						const failed = await call([
							"--json",
							"false",
							"batch",
							"--bail",
							"get url",
							"not-a-command",
							"get url",
						]);
						assert.equal(failed.isError, true);
						assert.equal(readRecord(failed.details).failureCategory, "upstream-error");
						assert.equal(readRecord(failed.details).parseError, undefined);
						assert.match(readString(readRecord(failed.details).data), new RegExp(fixture.baseUrl));
						const structured = await call([
							"--json",
							"false",
							"--json",
							"true",
							"batch",
							"--bail",
							"get url",
						]);
						assert.equal(structured.isError, false, resultText(structured));
						assert.ok(Array.isArray(readRecord(structured.details).data));
						assert.equal(readRecord(JSON.parse(resultText(structured))).success, true);
						await t.test("empty native rows preserve screenshot ownership", async () => {
							const paths = ["first.png", "second.png", "third.png"].map((name) =>
								join(root, name),
							);
							const result = await call(
								["batch"],
								JSON.stringify([
									["screenshot", paths[0]],
									[],
									["get", "title"],
									["screenshot", paths[1]],
									[],
									["screenshot", paths[2]],
								]),
							);
							assert.equal(result.isError, false, resultText(result));
							const rows = readArray(readRecord(result.details).batchSteps).map(readRecord);
							assert.equal(rows.length, 4);
							assert.deepEqual(
								[rows[0], rows[2], rows[3]].map(
									(row) => readRecord(readArray(row.artifacts)[0]).requestedPath,
								),
								paths,
							);
							assert.deepEqual(
								[rows[0], rows[2], rows[3]].map(
									(row) => readRecord(readArray(row.artifacts)[0]).absolutePath,
								),
								paths,
							);
							t.diagnostic(JSON.stringify({ paths, artifacts: rows.map((row) => row.artifacts) }));
						});
						await t.test(
							"native cookie and storage observations redact content, details and exports",
							async () => {
								assert.equal(
									(
										await call([
											"eval",
											'document.cookie="sid=Q2x9Lm3Np4Rs; path=/";localStorage.setItem("refresh","8f3a9c2b1d4e5f6a");localStorage.setItem("theme","dark");sessionStorage.setItem("refresh","opaque-first-line\\nopaque-continuation");true',
										])
									).isError,
									false,
								);
								for (const args of [
									["--json", "false", "cookies", "get"],
									["--json", "false", "storage", "local"],
									["--json", "false", "storage", "session", "get", "refresh"],
									["--json", "false", "batch", "cookies get", "storage local"],
									["storage", "local"],
								]) {
									const outputPath = join(root, "sensitive-output.txt");
									// These native observations share a page and overwrite one export path.
									// oxlint-disable-next-line no-await-in-loop
									const result = await executeRegisteredTool(harness.tool, harness.ctx, {
										args: ["--session", sessionName, ...args],
										outputPath,
									});
									// Every fixed sensitive-read variant must succeed before export redaction checks.
									// oxlint-disable-next-line node-test/no-conditional-assertion
									assert.equal(result.isError, false, resultText(result));
									// Verify the current export before the next observation overwrites it.
									// oxlint-disable-next-line no-await-in-loop
									const saved = await readFile(outputPath, "utf8");
									// Every fixed sensitive-read variant must remove independently seeded secret canaries.
									// oxlint-disable-next-line node-test/no-conditional-assertion
									assert.doesNotMatch(
										JSON.stringify(result) + saved,
										/Q2x9Lm3Np4Rs|8f3a9c2b1d4e5f6a|opaque-first-line|opaque-continuation/,
									);
									// Every fixed sensitive-read export must retain useful nonsecret field names.
									// oxlint-disable-next-line node-test/no-conditional-assertion
									assert.match(saved, /sid|refresh/);
									if (args.includes("local")) {
										// Local-storage variants must additionally retain harmless application data.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.match(saved, /theme.*dark/s);
									}
									t.diagnostic(
										JSON.stringify({
											args,
											data: readRecord(result.details).data,
											savedBytes: Buffer.byteLength(saved),
										}),
									);
								}
							},
						);
						await t.test(
							"empty stdin rows are skipped without dropping later native outcomes",
							async () => {
								const rows = [["get", "url"], [], [""], ["eval", "'🚀'"], ["get", "url"]];
								const continued = await call(["batch"], JSON.stringify(rows));
								assert.equal(continued.isError, true);
								const steps = readArray(readRecord(continued.details).batchSteps).map(readRecord);
								assert.ok(steps.length > 0, resultText(continued));
								assert.deepEqual(
									steps.map((step) => step.command),
									rows.filter((row) => row.length > 0),
								);
								assert.deepEqual(
									steps.map((step) => step.success),
									[true, false, true, true],
								);
								assert.equal(readRecord(steps[2].data).result, "🚀");
								const bailed = await call(["batch", "--bail"], JSON.stringify(rows));
								assert.equal(bailed.isError, true);
								assert.deepEqual(
									readArray(readRecord(bailed.details).batchSteps)
										.map(readRecord)
										.map((step) => step.command),
									[["get", "url"], [""]],
								);
								const text = await call(
									["--json", "false", "batch", "--bail"],
									JSON.stringify(rows),
								);
								assert.equal(text.isError, true);
								assert.match(
									readString(readRecord(text.details).stderr),
									/Command 3: Unknown command/,
								);
								assert.equal(readRecord(text.details).parseError, undefined);
								t.diagnostic(
									JSON.stringify({
										rows,
										continued: readRecord(continued.details).data,
										bailed: readRecord(bailed.details).data,
										textError: readRecord(text.details).stderr,
									}),
								);
							},
						);
					} finally {
						await call(["close"]);
					}
				},
			);
		} finally {
			await fixture.close();
			await rm(root, { recursive: true, force: true });
			await rm(socketDir, { recursive: true, force: true });
		}
	},
);

test(
	"contract suite matches confirmation launch policy surviving native nextActions",
	{ skip: !REAL_UPSTREAM_ENABLED && REAL_UPSTREAM_SKIP_REASON, concurrency: false },
	async (t) => {
		await assertInstalledAgentBrowserVersion();
		const root = await mkdtemp(join(tmpdir(), "piab-policy-"));
		const socketDir = await mkdtemp("/tmp/piab-p-");
		const fixture = await startAgentBrowserContractFixtureServer();
		await writeFile(join(root, "agent-browser.json"), JSON.stringify({ confirmActions: "click" }));
		try {
			await withPatchedEnv(
				{
					HOME: root,
					USERPROFILE: root,
					PI_CODING_AGENT_DIR: join(root, "pi"),
					PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_CONFIG: undefined,
					AGENT_BROWSER_CONFIRM_ACTIONS: "click",
					AGENT_BROWSER_NAMESPACE: undefined,
					AGENT_BROWSER_PROFILE: undefined,
					AGENT_BROWSER_RESTORE: undefined,
					AGENT_BROWSER_CDP: undefined,
					AGENT_BROWSER_AUTO_CONNECT: undefined,
				},
				async () => {
					const control = createExtensionHarness({ cwd: root });
					const controlCall = (args: readonly string[]) =>
						executeRegisteredTool(control.tool, control.ctx, {
							args: ["--session", "policy-control", ...args],
						});
					assert.equal((await controlCall(["open", `${fixture.baseUrl}/next`])).isError, false);
					const controlBefore = await controlCall(["tab", "list"]);
					try {
						for (const decision of ["deny", "confirm"] as const) {
							// Each decision subtest owns native confirmation and session cleanup in this environment.
							// oxlint-disable-next-line no-await-in-loop
							await t.test(`native pending then exact ${decision}`, async (decisionTest) => {
								let harness = createExtensionHarness({ cwd: root });
								const prefix = ["--session", `policy-${decision}`];
								const call = (args: readonly string[]) =>
									executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, ...args] });
								try {
									if (decision === "confirm") {
										const initial = await call([
											"--confirm-actions",
											"navigate,recording_restart,tab_new",
											"a11y",
											`${fixture.baseUrl}/next`,
											"--selector",
											"body",
										]);
										const approve = readArray(readRecord(initial.details).nextActions)
											.map(readRecord)
											.find((row) => row.id === "approve-confirmation");
										// The confirmed-audit fixture must establish a genuine native decision before continuing.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.ok(approve, resultText(initial));
										// The confirmed-audit fixture must actually approve its native decision.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(
											(
												await executeRegisteredTool(harness.tool, harness.ctx, {
													args: readArray(readRecord(approve.params).args).map(readString),
												})
											).isError,
											false,
										);
										const observed = await call(["get", "url"]);
										// The confirmed variant must establish its nonblank target before the next pending action.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(
											readRecord(readRecord(observed.details).data).url,
											`${fixture.baseUrl}/next`,
											"establish a genuine prior nonblank target before pending navigation",
										);
									}
									const pending = await call([
										"--confirm-actions",
										"navigate,recording_restart,tab_new",
										"a11y",
										`${fixture.baseUrl}/contract`,
										"--selector",
										"body",
									]);
									assert.equal(
										readRecord(pending.details).failureCategory,
										"confirmation-required",
										resultText(pending),
									);
									const action = (value: unknown, command: "confirm" | "deny") => {
										const result = readRecord(value);
										const next = readArray(readRecord(result.details).nextActions)
											.map(readRecord)
											.find(
												(row) =>
													row.id ===
													(command === "confirm" ? "approve-confirmation" : "deny-confirmation"),
											);
										assert.ok(next, resultText(result));
										assert.ok(
											!readArray(readRecord(next.params).args).includes("--confirm-actions"),
											"follow the exact native-tool action without repeating policy flags",
										);
										return { args: readArray(readRecord(next.params).args).map(readString) };
									};
									const pidPath = join(socketDir, `policy-${decision}.pid`);
									const pid = await readFile(pidPath, "utf8");
									const params = action(pending, decision);
									if (decision === "confirm") {
										harness = createExtensionHarness({
											cwd: root,
											branch: harness.ctx.sessionManager.getBranch().slice(),
										});
										await runExtensionEvent(
											harness.handlers,
											"session_start",
											{ reason: "resume" },
											harness.ctx,
										);
									}
									let settled = await executeRegisteredTool(harness.tool, harness.ctx, params);
									t.diagnostic(
										JSON.stringify({
											decision,
											pending: pending.details,
											params,
											settled: settled.details,
										}),
									);
									assert.doesNotMatch(resultText(settled), /No pending confirmation/);
									if (decision === "confirm") {
										for (
											let nested = 0;
											readRecord(settled.details).failureCategory === "confirmation-required" &&
											nested < 3;
											nested++
										) {
											// Confirm the currently returned native slot before inspecting its next decision.
											// oxlint-disable-next-line no-await-in-loop
											settled = await executeRegisteredTool(
												harness.tool,
												harness.ctx,
												action(settled, "confirm"),
											);
										}
									}
									assert.equal(settled.isError, false, resultText(settled));
									if (decision === "confirm") {
										const audit = readRecord(
											readRecord(readRecord(readRecord(settled.details).data).result).data,
										);
										// The confirmed variant must produce a useful audit; every decision checks settlement above.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.ok(
											Array.isArray(audit.violations),
											"the confirmed compound command completes a useful audit",
										);
										// The confirmed variant must audit the actual fixture target.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(audit.url, `${fixture.baseUrl}/contract`);
										const title = await call(["get", "title"]);
										// The confirmed variant must retain readable page state after settlement.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(title.isError, false, resultText(title));
										// The confirmed variant must observe the independent fixture title.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.match(
											JSON.stringify(readRecord(title.details).data),
											/Agent Browser Contract Fixture/,
										);
										const body = await call(["get", "text", "body"]);
										// The confirmed variant must support a content read after settlement.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(body.isError, false, resultText(body));
										// The confirmed variant must observe independently served fixture content.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.match(JSON.stringify(readRecord(body.details).data), /Mark ready/);
									}
									const before = await call(["get", "url"]);
									assert.equal(
										readRecord(readRecord(before.details).data).url,
										decision === "confirm" ? `${fixture.baseUrl}/contract` : "about:blank",
									);
									if (decision === "confirm") {
										const take = join(root, "confirmation-take.webm");
										const sentinel = join(root, "confirmation-sentinel.webm");
										await writeFile(sentinel, "NATIVE_CONFIRMATION_SENTINEL");
										// The confirmed variant must start a real recording before exercising restart denial.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal((await call(["record", "start", take])).isError, false);
										const restart = await call([
											"record",
											"restart",
											sentinel,
											`${fixture.baseUrl}/next`,
										]);
										// The confirmed variant must require a distinct decision for recording restart.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(
											readRecord(restart.details).failureCategory,
											"confirmation-required",
											resultText(restart),
										);
										const denied = await executeRegisteredTool(
											harness.tool,
											harness.ctx,
											action(restart, "deny"),
										);
										// The confirmed variant's recording denial must settle successfully.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(denied.isError, false, resultText(denied));
										// The denied restart must leave this fixture's independent sentinel untouched.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(await readFile(sentinel, "utf8"), "NATIVE_CONFIRMATION_SENTINEL");
										await decisionTest.test(
											"patched native recording restart requires a second navigation decision",
											{
												skip:
													process.env.PI_AGENT_BROWSER_NATIVE_COMPOUND_POLICY !== "1" &&
													"Requires the pinned native recording-policy patch; stock 0.38.1 does not guard this nested navigation.",
											},
											async () => {
												const nested = await call([
													"record",
													"restart",
													join(root, "nested-take.webm"),
													`${fixture.baseUrl}/next`,
												]);
												const advanced = await executeRegisteredTool(
													harness.tool,
													harness.ctx,
													action(nested, "confirm"),
												);
												t.diagnostic(
													JSON.stringify({
														nested: readRecord(nested.details).data,
														advanced: readRecord(advanced.details).data,
													}),
												);
												assert.equal(
													readRecord(advanced.details).failureCategory,
													"confirmation-required",
													"confirming recording_restart must still expose its native navigate confirmation",
												);
												assert.equal(
													(
														await executeRegisteredTool(
															harness.tool,
															harness.ctx,
															action(advanced, "deny"),
														)
													).isError,
													false,
												);
											},
										);
										const stopped = await call(["record", "stop"]);
										// The confirmed variant must stop its real recording before fixture cleanup.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(stopped.isError, false, resultText(stopped));
										// The confirmed variant's stop must retain the take that was not restarted.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.match(
											JSON.stringify(readRecord(stopped.details).data),
											/confirmation-take.webm/,
										);
										// The confirmed variant must leave actual recording bytes, not merely a success receipt.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.ok((await readFile(take)).length > 0);
										t.diagnostic(
											JSON.stringify({
												restart: restart.details,
												denied: denied.details,
												stopped: stopped.details,
											}),
										);
									}
									assert.equal(
										await readFile(pidPath, "utf8"),
										pid,
										"helpers and bare follow-ups preserve the native daemon and its pending policy",
									);
									t.diagnostic(
										JSON.stringify({
											decision,
											settled: readRecord(settled.details).data,
											after: readRecord(before.details).data,
											journalEntries: harness.ctx.sessionManager.getBranch().length,
										}),
									);
								} finally {
									await call(["close"]);
								}
							});
						}
						await t.test(
							"exact native action survives a confirmation-gated URL helper",
							async () => {
								const harness = createExtensionHarness({ cwd: root });
								const prefix = ["--session", "policy-helper-gated"];
								const url = `${fixture.baseUrl}/contract`;
								try {
									const pending = await executeRegisteredTool(harness.tool, harness.ctx, {
										args: [
											...prefix,
											"--confirm-actions",
											"navigate,url",
											"a11y",
											url,
											"--selector",
											"body",
										],
									});
									assert.equal(
										readRecord(pending.details).failureCategory,
										"confirmation-required",
									);
									assert.equal(readRecord(readRecord(pending.details).data).action, "navigate");
									const approval = readArray(readRecord(pending.details).nextActions)
										.map(readRecord)
										.find((action) => action.id === "approve-confirmation");
									assert.ok(approval);
									const pidPath = join(socketDir, "policy-helper-gated.pid");
									const pid = await readFile(pidPath, "utf8");
									const confirmed = await executeRegisteredTool(harness.tool, harness.ctx, {
										args: readArray(readRecord(approval.params).args).map(readString),
									});
									assert.equal(confirmed.isError, false, resultText(confirmed));
									const data = readRecord(readRecord(confirmed.details).data);
									const audit = readRecord(readRecord(data.result).data);
									assert.equal(
										data.action,
										"navigate",
										"the native slot still contains the requested action, not a hidden url probe",
									);
									assert.equal(audit.url, url);
									assert.ok(Array.isArray(audit.violations));
									assert.equal(await readFile(pidPath, "utf8"), pid);
								} finally {
									await executeRegisteredTool(harness.tool, harness.ctx, {
										args: [...prefix, "close"],
									});
								}
							},
						);
						await t.test(
							"native refused and invalid restart preserves page, sentinel and active take",
							async () => {
								const policy = join(root, "policy.json");
								await writeFile(policy, JSON.stringify({ deny: ["recording_restart"] }));
								const harness = createExtensionHarness({ cwd: root });
								const prefix = ["--session", "policy-record", "--action-policy", policy];
								const call = (args: readonly string[]) =>
									executeRegisteredTool(harness.tool, harness.ctx, { args: [...prefix, ...args] });
								const take = join(root, "take.webm");
								const sentinel = join(root, "sentinel.webm");
								await writeFile(sentinel, "NATIVE_POLICY_SENTINEL");
								try {
									const url = `${fixture.baseUrl}/contract`;
									assert.equal((await call(["open", url])).isError, false);
									assert.equal((await call(["record", "start", take])).isError, false);
									const before = await call(["tab", "list"]);
									const target = readRecord(
										readArray(readRecord(readRecord(before.details).data).tabs)[0],
									).targetId;
									const invalid = await call([
										"record",
										"restart",
										sentinel,
										`${fixture.baseUrl}/next`,
										url,
									]);
									assert.equal(invalid.isError, true);
									assert.match(
										readString(readRecord(invalid.details).error),
										/Unexpected argument for record restart:/,
										"extra operands must fail native argument validation, not action policy",
									);
									assert.ok(
										readArray(readRecord(invalid.details).nextActions)
											.map(readRecord)
											.some((action) => action.id === "stop-pending-recording"),
										"invalid restart must retain the native take's stop action",
									);
									assert.equal(
										(readRecord(invalid.details).artifacts === undefined
											? []
											: readArray(readRecord(invalid.details).artifacts)
										)
											.map(readRecord)
											.some((artifact) => artifact.subcommand === "restart-previous"),
										false,
									);
									const denied = await call([
										"record",
										"restart",
										sentinel,
										`${fixture.baseUrl}/next`,
									]);
									assert.equal(denied.isError, true);
									assert.ok(
										readArray(readRecord(denied.details).nextActions)
											.map(readRecord)
											.some((action) => action.id === "stop-pending-recording"),
										"policy rejection must retain the native take's stop action",
									);
									assert.match(
										JSON.stringify(readRecord(denied.details).error),
										/denied by policy/,
									);
									assert.equal(await readFile(sentinel, "utf8"), "NATIVE_POLICY_SENTINEL");
									const after = await call(["tab", "list"]);
									assert.equal(
										readRecord(readArray(readRecord(readRecord(after.details).data).tabs)[0])
											.targetId,
										target,
									);
									assert.equal(
										readRecord(readArray(readRecord(readRecord(after.details).data).tabs)[0]).url,
										url,
									);
									await call(["eval", "document.body.style.backgroundColor='red'"]);
									const stopped = await call(["record", "stop"]);
									assert.equal(stopped.isError, false, resultText(stopped));
									assert.match(JSON.stringify(readRecord(stopped.details).data), /take.webm/);
									assert.ok((await readFile(take)).length > 0);
									t.diagnostic(
										JSON.stringify({
											invalid: readRecord(invalid.details).error,
											denied: readRecord(denied.details).error,
											before: readRecord(before.details).data,
											after: readRecord(after.details).data,
											stopped: readRecord(stopped.details).data,
										}),
									);
								} finally {
									await call(["close"]);
								}
							},
						);
						const controlAfter = await controlCall(["tab", "list"]);
						const tabs = (value: unknown) =>
							readArray(readRecord(readRecord(readRecord(value).details).data).tabs)
								.map(readRecord)
								.map(({ targetId, url }) => ({ targetId, url }));
						assert.deepEqual(
							tabs(controlAfter),
							tabs(controlBefore),
							"confirmation settings and continuations do not replace an unrelated browser's targets",
						);
					} finally {
						await controlCall(["close"]);
					}
				},
			);
		} finally {
			await fixture.close();
			await rm(root, { recursive: true, force: true });
			await rm(socketDir, { recursive: true, force: true });
		}
	},
);

interface OutputShape {
	readonly dataKeys?: readonly string[];
	readonly detailKeys: readonly string[];
}
interface RealOutputShapesFixture {
	readonly targetVersion: string;
	readonly commands: Readonly<Record<string, OutputShape>>;
}

function readRefSnapshot(value: unknown) {
	const snapshot = readRecord(value);
	const refs = Object.fromEntries(
		Object.entries(readRecord(snapshot.refs)).map(([id, reference]) => {
			const ref = readRecord(reference);
			return [
				id,
				{
					name: readString(ref.name),
					role: readString(ref.role),
					...(ref.isEditable === undefined ? {} : { isEditable: readBoolean(ref.isEditable) }),
					...(ref.isContentEditable === undefined
						? {}
						: { isContentEditable: readBoolean(ref.isContentEditable) }),
				},
			];
		}),
	);
	const target = snapshot.target === undefined ? undefined : readRecord(snapshot.target);
	return {
		refIds: readArray(snapshot.refIds).map(readString),
		refs,
		...(snapshot.snapshotId === undefined ? {} : { snapshotId: readString(snapshot.snapshotId) }),
		...(snapshot.generation === undefined ? {} : { generation: readString(snapshot.generation) }),
		...(target === undefined
			? {}
			: {
					target: {
						url: readString(target.url),
						...(target.targetId === undefined ? {} : { targetId: readString(target.targetId) }),
						...(target.title === undefined ? {} : { title: readString(target.title) }),
					},
				}),
	};
}

async function readOutputShapesFixture(): Promise<RealOutputShapesFixture> {
	const fixture = readRecord(JSON.parse(await readFile(SHAPES_FIXTURE_PATH, "utf8")));
	const commands = Object.fromEntries(
		Object.entries(readRecord(fixture.commands)).map(([name, value]) => {
			const shape = readRecord(value);
			return [
				name,
				{
					detailKeys: readArray(shape.detailKeys).map(readString),
					...(shape.dataKeys === undefined
						? {}
						: { dataKeys: readArray(shape.dataKeys).map(readString) }),
				},
			];
		}),
	);
	return { targetVersion: readString(fixture.targetVersion), commands };
}

function assertHasKeys(
	record: Readonly<Record<string, unknown>> | undefined,
	keys: readonly string[],
	label: string,
): void {
	assert.ok(record, `expected ${label} details`);
	for (const key of keys) {
		assert.ok(Object.hasOwn(record, key), `expected ${label} to include ${key}`);
	}
}

function assertJsonIncludes(value: unknown, tokens: readonly string[], label: string): void {
	const serialized = typeof value === "undefined" ? "" : JSON.stringify(value);
	for (const token of tokens) {
		assert.ok(serialized.includes(token), `expected ${label} to include ${token}`);
	}
}

function assertSuccessfulResult(
	value: unknown,
	shape: OutputShape,
	label: string,
): Record<string, unknown> {
	const result = readRecord(value);
	assert.equal(result.isError, false, `${label} should succeed: ${resultText(result)}`);
	assertHasKeys(readRecord(result.details), shape.detailKeys, `${label} details`);
	assert.equal(readRecord(result.details).exitCode, 0, `${label} exit code`);
	if (shape.dataKeys) {
		assertHasKeys(readRecord(readRecord(result.details).data), shape.dataKeys, `${label} data`);
	}
	return readRecord(result.details);
}

function getResultValue(
	details: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): unknown {
	const data = details.data;
	if (typeof data === "object" && data !== null && !Array.isArray(data)) {
		const record = readRecord(data);
		for (const key of keys) {
			if (Object.hasOwn(record, key)) {
				return record[key];
			}
		}
	}
	return data;
}

function assertCoreCommandResult(
	result: unknown,
	shape: OutputShape,
	label: string,
	managedSessionName: string,
): Record<string, unknown> {
	const details = assertSuccessfulResult(result, shape, label);
	assert.equal(details.sessionName, managedSessionName, `${label} sessionName`);
	assert.equal(details.usedImplicitSession, true, `${label} usedImplicitSession`);
	return details;
}

async function runCoreCommand(
	harness: Readonly<Pick<ReturnType<typeof createExtensionHarness>, "tool" | "ctx">>,
	args: readonly string[],
	shape: OutputShape,
	managedSessionName: string,
	label = args.join(" "),
): Promise<Record<string, unknown>> {
	const result = await executeRegisteredTool(harness.tool, harness.ctx, { args });
	return assertCoreCommandResult(result, shape, label, managedSessionName);
}

async function readFileIfPresent(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) {
			return undefined;
		}
		throw error;
	}
}

async function assertInstalledAgentBrowserVersion(): Promise<string> {
	let stdout: string;
	try {
		({ stdout } = await execFileAsync("agent-browser", ["--version"], { timeout: 10_000 }));
	} catch (error) {
		let message = "Unknown failure";
		if (error instanceof Error) {
			message = error.message;
		} else if (error !== undefined) {
			message = JSON.stringify(error);
		}
		assert.fail(
			`agent-browser ${MINIMUM_AGENT_BROWSER_VERSION} or newer is required on PATH for real-upstream tests: ${message}`,
		);
	}
	const installedVersion = stdout.trim().replace(/^agent-browser\s+/, "");
	assert.ok(
		isSupportedAgentBrowserVersion(installedVersion),
		`real-upstream tests require agent-browser ${MINIMUM_AGENT_BROWSER_VERSION} or newer; found ${installedVersion}`,
	);
	return installedVersion;
}

async function initializeGitProject(path: string): Promise<void> {
	await execFileAsync("git", ["init", "-q", path]);
}

async function closeManagedSessionIfPresent(options: {
	readonly cwd: string;
	readonly sessionName?: string;
	readonly socketDir?: string;
	readonly namespace?: string;
}): Promise<void> {
	if (options.sessionName === undefined || options.sessionName.length === 0) {
		return;
	}
	await runAgentBrowserProcess({
		args: [
			"--json",
			"--namespace",
			options.namespace ?? "",
			"--session",
			options.sessionName,
			"close",
		],
		cwd: options.cwd,
		env: {
			AGENT_BROWSER_SOCKET_DIR:
				options.socketDir ?? process.env.PI_AGENT_BROWSER_SOCKET_DIR ?? getAgentBrowserSocketDir(),
			...(options.socketDir !== undefined && options.socketDir.length > 0
				? { PI_AGENT_BROWSER_SOCKET_DIR: options.socketDir }
				: {}),
		},
	});
}

async function assertRealUpstreamRestoredDaemonReuseFailsClosed(): Promise<void> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-real-restored-daemon-"));
	const socketDir = await mkdtemp(
		join(dirname(getAgentBrowserSocketDir() ?? join(tmpdir(), "piab")), "ru-"),
	);
	let sessionName: string | undefined;
	try {
		await initializeGitProject(tempDir);
		await withPatchedEnv(
			{
				AGENT_BROWSER_CONFIG: undefined,
				AGENT_BROWSER_ENCRYPTION_KEY: process.platform === "win32" ? "a".repeat(64) : undefined,
				AGENT_BROWSER_SOCKET_DIR: socketDir,
				PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
				HOME: tempDir,
				USERPROFILE: tempDir,
				PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: undefined,
			},
			async () => {
				const firstHarness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(
					firstHarness.handlers,
					"session_start",
					{ reason: "new" },
					firstHarness.ctx,
				);
				const opened = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, {
					args: ["open", "about:blank"],
					sessionMode: "fresh",
				});
				assert.equal(
					opened.isError,
					false,
					`restored-daemon setup open failed: ${resultText(opened)}`,
				);
				sessionName = readString(readRecord(opened.details).sessionName);

				const restoredHarness = createExtensionHarness({
					cwd: tempDir,
					branch: firstHarness.ctx.sessionManager.getBranch().slice(),
				});
				await runExtensionEvent(
					restoredHarness.handlers,
					"session_start",
					{ reason: "resume" },
					restoredHarness.ctx,
				);
				const blocked = await executeRegisteredTool(restoredHarness.tool, restoredHarness.ctx, {
					args: ["--proxy", "http://127.0.0.1:8080", "open", "about:blank"],
				});
				assert.equal(blocked.isError, true);
				assert.match(
					readString(readRecord(blocked.details).validationError),
					/does not match the requested managed-restore policy/,
				);
				assert.equal(readRecord(blocked.details).exitCode, undefined);

				const closed = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, {
					args: ["close"],
				});
				assert.equal(
					closed.isError,
					false,
					`restored-daemon cleanup close failed: ${resultText(closed)}`,
				);
				sessionName = undefined;
			},
		);
	} finally {
		await closeManagedSessionIfPresent({ cwd: tempDir, sessionName, socketDir });
		await rm(tempDir, { force: true, recursive: true });
		await rm(socketDir, { force: true, recursive: true });
	}
}

async function assertRealUpstreamRestoreStorageSymlinkFailsClosed(): Promise<void> {
	if (process.platform === "win32") {
		return;
	}
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-real-symlink-"));
	const socketDir = await mkdtemp(
		join(dirname(getAgentBrowserSocketDir() ?? join(tmpdir(), "piab")), "ru-"),
	);
	const targetDir = join(tempDir, "outside-state-target");
	await initializeGitProject(tempDir);
	await mkdir(join(tempDir, ".agent-browser"), { recursive: true, mode: 0o700 });
	await mkdir(targetDir);
	await symlink(targetDir, join(tempDir, ".agent-browser", "sessions"), "dir");
	let sessionName: string | undefined;
	try {
		await withPatchedEnv(
			{
				AGENT_BROWSER_CONFIG: undefined,
				AGENT_BROWSER_ENCRYPTION_KEY: undefined,
				AGENT_BROWSER_SOCKET_DIR: socketDir,
				PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
				HOME: tempDir,
				PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: undefined,
			},
			async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "about:blank"],
					sessionMode: "fresh",
				});
				assert.equal(
					opened.isError,
					false,
					`symlink fail-closed open should succeed without restore: ${resultText(opened)}`,
				);
				assert.equal(readRecord(opened.details).managedSessionRestoreDisabled, true);
				sessionName = readString(readRecord(opened.details).sessionName);
				const closed = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
				assert.equal(
					closed.isError,
					false,
					`symlink fail-closed close should succeed: ${resultText(closed)}`,
				);
				sessionName = undefined;
			},
		);
		assert.deepEqual(
			await readdir(targetDir),
			[],
			"real upstream must not write restore state through the sessions symlink, including on close",
		);
	} finally {
		await closeManagedSessionIfPresent({ cwd: tempDir, sessionName, socketDir });
		await rm(tempDir, { force: true, recursive: true });
		await rm(socketDir, { force: true, recursive: true });
	}
}

async function assertRealUpstreamNestedRestoreStorageSymlinkFailsClosed(): Promise<void> {
	if (process.platform === "win32") {
		return;
	}
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-real-nested-symlink-"));
	const socketDir = await mkdtemp(
		join(dirname(getAgentBrowserSocketDir() ?? join(tmpdir(), "piab")), "ru-"),
	);
	const outsideStateFile = join(tempDir, "outside-candidate.json");
	const temporaryDirectory = join(tempDir, ".agent-browser", "sessions", ".tmp");
	await initializeGitProject(tempDir);
	await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
	await writeFile(outsideStateFile, "unchanged");
	await symlink(outsideStateFile, join(temporaryDirectory, "candidate.json"), "file");
	let sessionName: string | undefined;
	try {
		await withPatchedEnv(
			{
				AGENT_BROWSER_CONFIG: undefined,
				AGENT_BROWSER_ENCRYPTION_KEY: undefined,
				AGENT_BROWSER_SOCKET_DIR: socketDir,
				PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
				HOME: tempDir,
				PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: undefined,
			},
			async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "about:blank"],
					sessionMode: "fresh",
				});
				assert.equal(
					opened.isError,
					false,
					`nested symlink fail-closed open should succeed without restore: ${resultText(opened)}`,
				);
				assert.equal(readRecord(opened.details).managedSessionRestoreDisabled, true);
				sessionName = readString(readRecord(opened.details).sessionName);
				const closed = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
				assert.equal(
					closed.isError,
					false,
					`nested symlink fail-closed close should succeed: ${resultText(closed)}`,
				);
				sessionName = undefined;
			},
		);
		assert.equal(await readFile(outsideStateFile, "utf8"), "unchanged");
	} finally {
		await closeManagedSessionIfPresent({ cwd: tempDir, sessionName, socketDir });
		await rm(tempDir, { force: true, recursive: true });
		await rm(socketDir, { force: true, recursive: true });
	}
}

async function assertRealUpstreamRelativeHomeFailsClosed(): Promise<void> {
	if (process.platform === "win32") {
		return;
	}
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-real-relative-home-"));
	const socketDir = await mkdtemp(
		join(dirname(getAgentBrowserSocketDir() ?? join(tmpdir(), "piab")), "ru-"),
	);
	let sessionName: string | undefined;
	try {
		await initializeGitProject(tempDir);
		await withPatchedEnv(
			{
				AGENT_BROWSER_CONFIG: undefined,
				AGENT_BROWSER_ENCRYPTION_KEY: undefined,
				AGENT_BROWSER_SOCKET_DIR: socketDir,
				PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
				HOME: "relative-home",
				PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: undefined,
			},
			async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "about:blank"],
					sessionMode: "fresh",
				});
				assert.equal(
					opened.isError,
					false,
					`relative-home fail-closed open should succeed without restore: ${resultText(opened)}`,
				);
				assert.equal(readRecord(opened.details).managedSessionRestoreDisabled, true);
				sessionName = readString(readRecord(opened.details).sessionName);
				const closed = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
				assert.equal(
					closed.isError,
					false,
					`relative-home fail-closed close should succeed: ${resultText(closed)}`,
				);
				sessionName = undefined;
			},
		);
		await assert.rejects(readdir(join(tempDir, "relative-home", ".agent-browser")));
	} finally {
		await closeManagedSessionIfPresent({ cwd: tempDir, sessionName, socketDir });
		await rm(tempDir, { force: true, recursive: true });
		await rm(socketDir, { force: true, recursive: true });
	}
}

async function assertRealUpstreamLocalDaemonPassesThrough(): Promise<void> {
	if (process.platform === "win32") {
		return;
	}
	const shortTempRoot = dirname(getAgentBrowserSocketDir() ?? join(tmpdir(), "piab"));
	const tempDir = await mkdtemp(join(shortTempRoot, "u-"));
	const socketDir = join(tempDir, "sockets");
	const configPath = join(tempDir, "empty.json");
	const sessionName = `unsafe-${process.pid}`;
	const safeSessionName = `piab-safe-${process.pid}`;
	const upstreamEnv = {
		...process.env,
		AGENT_BROWSER_DEFAULT_TIMEOUT: "25000",
		AGENT_BROWSER_IDLE_TIMEOUT_MS: "900000",
		AGENT_BROWSER_SOCKET_DIR: socketDir,
		HOME: tempDir,
	};
	try {
		await mkdir(join(tempDir, ".agent-browser"), { recursive: true });
		await mkdir(socketDir, { mode: 0o700 });
		await writeFile(configPath, "{}\n");
		const protectedFile = join(tempDir, ".agent-browser", "review-state.txt");
		await writeFile(protectedFile, "fixture-value\n");
		const fixturePath = join(tempDir, "fixture.html");
		await writeFile(
			fixturePath,
			`<!doctype html><title>PENDING</title><script>fetch(${JSON.stringify(pathToFileURL(protectedFile).href)}).then(r => r.text()).then(() => document.title = "READABLE").catch(() => document.title = "BLOCKED");</script>`,
		);
		await execFileAsync(
			"agent-browser",
			[
				"--json",
				"--config",
				configPath,
				"--session",
				sessionName,
				"--allow-file-access",
				"true",
				"open",
				"about:blank",
			],
			{
				cwd: tempDir,
				env: upstreamEnv,
				timeout: 30_000,
			},
		);
		await execFileAsync(
			"agent-browser",
			[
				"--json",
				"--config",
				configPath,
				"--session",
				sessionName,
				"open",
				pathToFileURL(fixturePath).href,
			],
			{
				cwd: tempDir,
				env: upstreamEnv,
				timeout: 30_000,
			},
		);
		await execFileAsync(
			"agent-browser",
			[
				"--json",
				"--config",
				configPath,
				"--session",
				sessionName,
				"wait",
				"--fn",
				"document.title !== 'PENDING'",
			],
			{ cwd: tempDir, env: upstreamEnv, timeout: 30_000 },
		);
		const control = await execFileAsync(
			"agent-browser",
			["--json", "--config", configPath, "--session", sessionName, "get", "title"],
			{
				cwd: tempDir,
				env: upstreamEnv,
				timeout: 30_000,
			},
		);
		const daemonPid = Number(await readFile(join(socketDir, `${sessionName}.pid`), "utf8"));
		assert.ok(Number.isSafeInteger(daemonPid) && daemonPid > 0);
		const controlData = readRecord(readRecord(JSON.parse(control.stdout)).data);
		assert.equal(
			controlData.title ?? controlData.result,
			"READABLE",
			"control must prove the reused unsafe daemon can read protected agent-browser storage",
		);
		await execFileAsync(
			"agent-browser",
			["--json", "--config", configPath, "--session", sessionName, "open", "about:blank"],
			{
				cwd: tempDir,
				env: upstreamEnv,
				timeout: 30_000,
			},
		);
		await withPatchedEnv(
			{
				AGENT_BROWSER_DEFAULT_TIMEOUT: "25000",
				AGENT_BROWSER_IDLE_TIMEOUT_MS: "900000",
				HOME: tempDir,
				PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
			},
			async () => {
				const opened = await runAgentBrowserProcess({
					args: ["--json", "--session", sessionName, "open", pathToFileURL(fixturePath).href],
					cwd: tempDir,
				});
				assert.equal(opened.exitCode, 0, opened.spawnError?.message ?? opened.stderr);
				const ready = await runAgentBrowserProcess({
					args: [
						"--json",
						"--session",
						sessionName,
						"wait",
						"--fn",
						"document.title !== 'PENDING'",
					],
					cwd: tempDir,
				});
				assert.equal(ready.exitCode, 0, ready.spawnError?.message ?? ready.stderr);
				const title = await runAgentBrowserProcess({
					args: ["--json", "--session", sessionName, "get", "title"],
					cwd: tempDir,
				});
				assert.equal(title.exitCode, 0, title.spawnError?.message ?? title.stderr);
				const titleData = readRecord(readRecord(JSON.parse(title.stdout)).data);
				assert.equal(titleData.title ?? titleData.result, "READABLE");
				assert.equal(
					Number(await readFile(join(socketDir, `${sessionName}.pid`), "utf8")),
					daemonPid,
					"wrapper reuse must preserve the caller daemon and its local-file capability",
				);

				const safeOpen = await runAgentBrowserProcess({
					args: ["--json", "--session", safeSessionName, "open", pathToFileURL(fixturePath).href],
					cwd: tempDir,
					ownedManagedSession: true,
				});
				assert.equal(safeOpen.exitCode, 0, safeOpen.spawnError?.message ?? safeOpen.stderr);
			},
		);
	} finally {
		for (const name of [sessionName, safeSessionName]) {
			// Close both daemons in order before their shared socket directory is deleted.
			// oxlint-disable-next-line no-await-in-loop
			await execFileAsync(
				"agent-browser",
				["--json", "--config", configPath, "--session", name, "close"],
				{
					cwd: tempDir,
					env: upstreamEnv,
					timeout: 30_000,
				},
			);
		}
		await rm(tempDir, { force: true, recursive: true });
	}
}

for (const reconstructed of [false, true]) {
	test(
		`real upstream agent-browser contract suite matches owned read continuity (reconstructed=${reconstructed})`,
		{ skip: !REAL_UPSTREAM_ENABLED, timeout: 60_000 },
		async () => {
			await assertInstalledAgentBrowserVersion();
			const dir = await mkdtemp(join(tmpdir(), "or-"));
			const socketDir = await mkdtemp(
				join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "or-"),
			);
			const fixture = await startAgentBrowserContractFixtureServer();
			await initializeGitProject(dir);
			try {
				await withPatchedEnv(
					{
						...Object.fromEntries(
							Object.keys(process.env)
								.filter((name) => /^(?:PI_)?AGENT_BROWSER_/.test(name))
								.map((name) => [name, undefined]),
						),
						HOME: dir,
						USERPROFILE: dir,
						PI_CODING_AGENT_DIR: join(dir, "pi"),
						AGENT_BROWSER_ENCRYPTION_KEY: process.platform === "win32" ? "a".repeat(64) : undefined,
						PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
						AGENT_BROWSER_SOCKET_DIR: socketDir,
					},
					async () => {
						const branch: unknown[] = [];
						let harness = createExtensionHarness({ cwd: dir, branch });
						let sessionName: string | undefined, restoreKey: string | undefined;
						let daemonPid: number | undefined;
						try {
							await runExtensionEvent(
								harness.handlers,
								"session_start",
								{ reason: "new" },
								harness.ctx,
							);
							const url = `${fixture.baseUrl}/contract`,
								marker = "unsaved-owned-read";
							const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["open", url],
								sessionMode: "fresh",
							});
							sessionName = readString(readRecord(opened.details).sessionName);
							assert.equal(opened.isError, false, resultText(opened));
							branch.push(
								createToolBranchEntry({
									details: readRecord(opened.details),
									isError: opened.isError,
								}),
							);
							const prefix = ["--namespace", "", "--session", sessionName];
							const marked = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["eval", "--stdin"],
								stdin: `(() => { window.__ownedContinuity = ${JSON.stringify(marker)}; document.querySelector('#name-input').value = window.__ownedContinuity; sessionStorage.setItem('ownedContinuity', window.__ownedContinuity); return true; })()`,
							});
							assert.equal(marked.isError, false, resultText(marked));
							const before = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: [...prefix, "session", "info"],
							});
							assert.equal(before.isError, false, resultText(before));
							const nativeBefore = readRecord(readRecord(before.details).data);
							daemonPid = readNumber(nativeBefore.pid);
							assert.ok(daemonPid > 0);
							restoreKey = readString(readRecord(nativeBefore.runtime).restoreKey);
							assert.match(restoreKey, /^piab-r2-/);
							if (reconstructed) {
								await runExtensionEvent(
									harness.handlers,
									"session_shutdown",
									{ reason: "reload" },
									harness.ctx,
								);
								harness = createExtensionHarness({ cwd: dir, branch });
								await runExtensionEvent(
									harness.handlers,
									"session_start",
									{ reason: "resume" },
									harness.ctx,
								);
								// The replay fixture must retain its established native PID; all modes check continuity below.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(
									Number(await readFile(join(socketDir, `${sessionName}.pid`), "utf8")),
									nativeBefore.pid,
								);
							}
							for (const args of [
								["read", url],
								["batch", `read ${url}`],
							]) {
								// Each read must retain the owned daemon before the next command touches it.
								// oxlint-disable-next-line no-await-in-loop
								const result = await executeRegisteredTool(harness.tool, harness.ctx, {
									args: [...prefix, ...args],
								});
								// Every fixed read variant must succeed before daemon continuity checks.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(result.isError, false, resultText(result));
								// Inspect this command's daemon identity before a later command can replace it.
								// oxlint-disable-next-line no-await-in-loop
								const after = await executeRegisteredTool(harness.tool, harness.ctx, {
									args: [...prefix, "session", "info"],
								});
								const nativeAfter = readRecord(readRecord(after.details).data);
								// Every fixed read variant must preserve native daemon identity.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(
									nativeAfter.pid,
									nativeBefore.pid,
									`${args[0]} must not replace the owned daemon`,
								);
								// Every fixed read variant must preserve automatic restore identity.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(readRecord(nativeAfter.runtime).restoreKey, restoreKey);
								// Verify the retained page before the next loop's browser operation.
								// oxlint-disable-next-line no-await-in-loop
								const current = await executeRegisteredTool(harness.tool, harness.ctx, {
									args: ["get", "url"],
								});
								// Every fixed continuity variant must remain readable after native inspection.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(current.isError, false, resultText(current));
								// Every fixed continuity variant must retain routing to the same session.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(readRecord(current.details).sessionName, sessionName);
								// Observe in-memory form/storage continuity immediately after this native read.
								// oxlint-disable-next-line no-await-in-loop
								const state = await executeRegisteredTool(harness.tool, harness.ctx, {
									args: ["eval", "--stdin"],
									stdin:
										"({ url: location.href, marker: window.__ownedContinuity, form: document.querySelector('#name-input').value, sessionMarker: sessionStorage.getItem('ownedContinuity') })",
								});
								// Every fixed continuity variant must observe its retained in-memory page.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(state.isError, false, resultText(state));
								// Every fixed continuity variant must retain independent form, storage, and JS markers.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.deepEqual(getResultValue(readRecord(state.details), ["result"]), {
									url,
									marker,
									form: marker,
									sessionMarker: marker,
								});
							}
						} finally {
							await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
							await runExtensionEvent(
								harness.handlers,
								"session_shutdown",
								{ reason: "quit" },
								harness.ctx,
							);
							if (sessionName !== undefined && sessionName.length > 0) {
								const closed = await runAgentBrowserProcess({
									args: ["--json", "--namespace", "", "close", "--all"],
									cwd: dir,
									env: { AGENT_BROWSER_SOCKET_DIR: socketDir },
								});
								// Every initialized fixture must close; failed initialization already fails the test.
								// oxlint-disable-next-line node-test/no-conditional-assertion
								assert.equal(closed.exitCode, 0, closed.stderr);
							}
							assert.ok(
								daemonPid !== undefined && daemonPid > 0,
								"capture a genuine PID before close",
							);
							assert.equal(
								await waitForTestPidExit(daemonPid, 10_000),
								true,
								"the private native daemon must exit",
							);
						}
					},
				);
			} finally {
				await fixture.close();
				await rm(dir, { recursive: true, force: true });
				await rm(socketDir, { recursive: true, force: true });
			}
		},
	);
}

test(
	"real upstream agent-browser contract suite matches navigation availability and tab setup",
	{ skip: !REAL_UPSTREAM_ENABLED, timeout: 60_000 },
	async (t) => {
		const dir = await mkdtemp(join(tmpdir(), "wm-"));
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
					const version = (
						await runAgentBrowserProcess({ args: ["--version"], cwd: dir })
					).stdout.match(/agent-browser (\d+)\.(\d+)\./);
					assert.ok(version);
					if (Number(version[1]) === 0 && Number(version[2]) < 37) {
						t.skip("Native navigation availability and tab setup require 0.37 or newer.");
						return;
					}
					const h = createExtensionHarness({ cwd: dir });
					await runExtensionEvent(h.handlers, "session_start", { reason: "new" }, h.ctx);
					const call = async (args: readonly string[]) => {
						const result = await executeRegisteredTool(h.tool, h.ctx, { args });
						assert.equal(result.isError, false, resultText(result));
						return result;
					};
					let daemonPid: number | undefined;
					try {
						const plain = await call(["open", `${fixture.baseUrl}/contract`]);
						daemonPid = Number(
							await readFile(
								join(socketDir, `${readString(readRecord(plain.details).sessionName)}.pid`),
								"utf8",
							),
						);
						assert.equal(readRecord(readRecord(plain.details).data).webmcp, undefined);
						assert.doesNotMatch(resultText(plain), /WebMCP tools are available/);
						const available = await call(["open", `${fixture.baseUrl}/webmcp`]);
						const catalog = readRecord(readRecord(readRecord(available.details).data).webmcp);
						assert.deepEqual(
							{
								experimental: catalog.experimental,
								available: catalog.available,
								toolCount: catalog.toolCount,
							},
							{ experimental: true, available: true, toolCount: 2 },
						);
						if (Number(version[1]) > 0 || Number(version[2]) >= 38) {
							// Catalog-capable native versions must report readiness; all versions check availability above.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(catalog.status, "ready");
							// Catalog-capable versions must expose the independent fixture's declared tools.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.deepEqual(
								readArray(catalog.tools).map((tool) => readRecord(tool).name),
								["set_message", "wait_for_cancel"],
							);
							// Catalog-capable versions must retain native omitted-schema semantics.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.ok(
								readArray(catalog.tools).every(
									(tool) => readRecord(tool).inputSchema === undefined,
								),
								"automatic discovery omits full schemas",
							);
						}
						assert.match(resultText(available), /WebMCP tools are available.*webmcp list/);
						for (const [headers, expected] of [
							[{ "x-fixture": "batch-fidelity" }, "present"],
							[{}, "missing"],
						] as const) {
							// Set headers before opening the next fixture tab that must inherit them.
							// oxlint-disable-next-line no-await-in-loop
							await call(["set", "headers", JSON.stringify(headers)]);
							// First-load header inheritance requires tab creation after the preceding set.
							// oxlint-disable-next-line no-await-in-loop
							await call(["tab", "new", `${fixture.baseUrl}/headers`]);
							// Inspect the tab's first-load receipt before clearing or replacing header state.
							// oxlint-disable-next-line no-await-in-loop
							const value = await call(["get", "value", "#header-value"]);
							// Both fixed header-set/clear fixtures must match the independent first-load receipt.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.equal(readRecord(readRecord(value.details).data).value, expected);
						}
						t.diagnostic(
							"Native WebMCP availability is visible; native first-load header inheritance and clearing both match the fixture.",
						);
					} finally {
						await executeRegisteredTool(h.tool, h.ctx, { args: ["close"] });
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
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"real upstream agent-browser contract suite matches QA non-pass after same-URL error-buffer rollover",
	{ skip: !REAL_UPSTREAM_ENABLED, timeout: 90_000 },
	async (t) => {
		const version = await assertInstalledAgentBrowserVersion();
		const dir = await mkdtemp(join(tmpdir(), "qr-"));
		const socketDir = join(dir, "s");
		const fixture = await startAgentBrowserContractFixtureServer();
		const url = `${fixture.baseUrl}/qa-error-residue`;
		try {
			await withPatchedEnv(
				{
					...Object.fromEntries(
						Object.keys(process.env)
							.filter((name) => /^(?:PI_)?AGENT_BROWSER_/.test(name))
							.map((name) => [name, undefined]),
					),
					HOME: dir,
					USERPROFILE: dir,
					PI_CODING_AGENT_DIR: join(dir, "pi"),
					PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_SOCKET_DIR: socketDir,
					PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0",
				},
				async () => {
					const h = createExtensionHarness({ cwd: dir });
					await runExtensionEvent(h.handlers, "session_start", { reason: "new" }, h.ctx);
					const call = async (args: readonly string[], outputPath?: string) => {
						const result = await executeRegisteredTool(h.tool, h.ctx, { args, outputPath });
						assert.equal(result.isError, false, resultText(result));
						return result;
					};
					const readErrors = async (name: string) => {
						const path = join(dir, name);
						await call(["errors"], path);
						const data = readRecord(JSON.parse(await readFile(path, "utf8")));
						return { errors: readArray(data.errors) };
					};
					try {
						const clean = await executeRegisteredTool(h.tool, h.ctx, {
							qa: {
								url: `${fixture.baseUrl}/contract`,
								expectedText: "Agent Browser Contract Fixture",
							},
						});
						assert.equal(clean.isError, false, resultText(clean));
						assert.equal(readRecord(readRecord(clean.details).qaPreset).passed, true);

						await call(["open", url]);
						await call(["wait", "--fn", "window.qaErrorsThrown === 1100"]);
						const before = await readErrors("before.json");
						assert.equal(before.errors.length, 1000, "the native FIFO must be saturated");
						assert.equal(
							new Set(before.errors.map((row) => JSON.stringify(row))).size,
							1,
							"all native error rows must match",
						);
						await call(["eval", "sessionStorage.setItem('qa-error-count', '1')"]);
						const repeated = await executeRegisteredTool(h.tool, h.ctx, {
							qa: {
								url,
								expectedText: "Repeated error fixture",
								checkConsole: false,
								checkNetwork: false,
							},
						});
						const counter = getResultValue(
							readRecord((await call(["eval", "window.qaErrorsThrown"])).details),
							["result"],
						);
						assert.equal(counter, 1, "the new document must actually throw again at the same URL");
						const after = await readErrors("after.json");
						const identicalRows = JSON.stringify(after.errors) === JSON.stringify(before.errors);
						const analysis = readRecord(readRecord(repeated.details).qaPreset);
						const failedChecks = readArray(analysis.failedChecks).map(readString);
						t.diagnostic(
							JSON.stringify({
								version,
								url,
								before: before.errors.length,
								after: after.errors.length,
								identicalRows,
								counter,
								qa: analysis,
								isError: repeated.isError,
							}),
						);
						assert.equal(
							analysis.passed,
							false,
							"a newly thrown page error must never yield a QA pass, even when FIFO rollover hides it",
						);
						assert.equal(repeated.isError, true);
						assert.equal(readRecord(repeated.details).resultCategory, "failure");
						assert.equal(readRecord(repeated.details).failureCategory, "qa-failure");
						assert.ok(failedChecks.some((check) => /page.error/.test(check)));
						if (identicalRows) {
							// The identical-row fixture must report uncertainty; every fixture checks QA failure above.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.match(failedChecks.join("\n"), /page-error check could not be verified/);
							// The identical-row fixture must not invent a measured number of new page errors.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.doesNotMatch(failedChecks.join("\n"), /\d+ page error\(s\)/);
						}
						assert.doesNotMatch(
							resultText(repeated),
							/QA preset passed|ignored as unchanged|Only unchanged residue/,
						);
					} finally {
						await call(["close"]);
						await runExtensionEvent(h.handlers, "session_shutdown", { reason: "quit" }, h.ctx);
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
	"real upstream agent-browser contract suite matches reported browser regressions",
	{ skip: !REAL_UPSTREAM_ENABLED, timeout: 60_000 },
	async (t) => {
		await assertInstalledAgentBrowserVersion();
		const dir = await mkdtemp(join(tmpdir(), "br-"));
		const socketDir = await mkdtemp(
			join(dirname(getAgentBrowserSocketDir() ?? join(tmpdir(), "piab")), "br-"),
		);
		const fixture = await startAgentBrowserContractFixtureServer();
		try {
			await withPatchedEnv(
				{
					...Object.fromEntries(
						Object.keys(process.env)
							.filter((name) => /^(?:PI_)?AGENT_BROWSER_/.test(name))
							.map((name) => [name, undefined]),
					),
					HOME: dir,
					USERPROFILE: dir,
					PI_CODING_AGENT_DIR: join(dir, "pi"),
					PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_SOCKET_DIR: socketDir,
					PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: "0",
				},
				async () => {
					const h = createExtensionHarness({ cwd: dir });
					const call = async (params: unknown) => {
						const result = await executeRegisteredTool(h.tool, h.ctx, params);
						assert.equal(result.isError, false, resultText(result));
						return result;
					};
					try {
						const opened = await call({
							args: ["open", `${fixture.baseUrl}/browser-regressions`],
							sessionMode: "fresh",
						});
						const sessionName = readString(readRecord(opened.details).sessionName);
						await call({ args: ["wait", "--fn", "document.body.dataset.ready === 'yes'"] });
						await t.test(
							"filtered network details and exports redact the same credentials as ordinary results",
							async () => {
								const ordinary = await call({ args: ["network", "requests"] });
								assert.doesNotMatch(
									JSON.stringify(ordinary),
									/fixture-url-secret|fixture-header-secret/,
								);
								const outputPath = join(dir, "network.json");
								const filtered = await call({
									args: ["network", "requests", "--current-page"],
									outputPath,
								});
								assert.match(
									JSON.stringify(readRecord(filtered.details).data),
									/browser-regression-api/,
									"the credential-bearing request must actually be present",
								);
								assert.doesNotMatch(
									JSON.stringify(filtered),
									/fixture-url-secret|fixture-header-secret/,
								);
								assert.doesNotMatch(
									await readFile(outputPath, "utf8"),
									/fixture-url-secret|fixture-header-secret/,
								);
							},
						);
						await t.test(
							"download runs the export handler and saves its generated CSV",
							async () => {
								const path = join(dir, "report.csv");
								const result = await call({ args: ["download", "#export", path] });
								assert.equal(await readFile(path, "utf8"), "name,total\nAlice,42\n");
								assert.equal(
									readRecord(readRecord(result.details).artifactVerification).verified,
									true,
								);
								assert.equal(
									getResultValue(
										readRecord(
											(await call({ args: ["eval", "window.exportClicks || 0"] })).details,
										),
										["result"],
									),
									1,
								);
								for (const selector of ["#static-download", "#redirect-download"]) {
									const savedPath = join(dir, `${selector.slice(1)}.txt`);
									// Native downloads share the active page and its event listener.
									// oxlint-disable-next-line no-await-in-loop
									await call({ args: ["download", selector, savedPath] });
									// Verify this download before starting another on the same native page.
									// oxlint-disable-next-line no-await-in-loop
									const downloadedText = await readFile(savedPath, "utf8");
									// Both fixed static/redirect downloads must retain independently served bytes.
									// oxlint-disable-next-line node-test/no-conditional-assertion
									assert.equal(downloadedText, DOWNLOAD_FIXTURE_CONTENT);
								}
							},
						);
						await t.test(
							"accessible-name collisions cannot turn a trusted ref click into a failure",
							async () => {
								const snapshot = await call({ args: ["snapshot", "-i"] });
								const refSnapshot = readRefSnapshot(readRecord(snapshot.details).refSnapshot);
								const ref = Object.entries(refSnapshot.refs).find(
									([, value]) => value.role === "button" && value.name === "Save",
								)?.[0];
								assert.ok(ref !== undefined && ref.length > 0);
								const clicked = await call({ args: ["click", `@${ref}`] });
								assert.equal(readRecord(clicked.details).clickDispatch, undefined);
								assert.doesNotMatch(
									JSON.stringify(readRecord(clicked.details).nextActions),
									/retry-click-after-dispatch-miss/,
								);
								const state = await call({
									args: ["eval", "--stdin"],
									stdin:
										"({save:Number(document.querySelector('#save').dataset.clicks||0),copy:Number(document.querySelector('#copy').dataset.clicks||0),trusted:document.querySelector('#save').dataset.trusted})",
								});
								assert.deepEqual(getResultValue(readRecord(state.details), ["result"]), {
									save: 1,
									copy: 0,
									trusted: "true",
								});
								const observe = Object.entries(refSnapshot.refs).find(
									([, value]) => value.name === "Observe",
								)?.[0];
								assert.ok(observe !== undefined && observe.length > 0);
								await withOwnedManagedSessionContext(
									{ cwd: dir, sessionName, restoreState: new ManagedSessionRestoreState() },
									async () => {
										const options = {
											commandTokens: ["click", `@${observe}`],
											cwd: dir,
											sessionName,
											refSnapshot,
										};
										const probe = await prepareClickDispatchProbe(options);
										assert.ok(
											probe,
											"correctly identified ref targets must retain no-dispatch detection",
										);
										assert.equal(
											(await collectClickDispatchDiagnostic({ ...options, probe }))?.status,
											"no-native-event-observed",
										);
									},
								);
							},
						);
						await t.test(
							"XPath probes cannot mistake a main-frame element for the selected child frame",
							async () => {
								await call({ args: ["frame", "#child-frame"] });
								try {
									await call({ args: ["click", "xpath=//*[@id='frame-button']"] });
									const status = await call({ args: ["get", "text", "#frame-status"] });
									assert.equal(
										getResultValue(readRecord(status.details), ["text"]),
										"Frame clicked",
									);
								} finally {
									await call({ args: ["frame", "main"] });
								}
								const residue = await call({
									args: ["eval", "--stdin"],
									stdin:
										"({ markers: Object.keys(window).filter(key => key.startsWith('__piAgentBrowserClickDispatchProbe_')), attributes: [...document.querySelectorAll('*')].flatMap(el => el.getAttributeNames()).filter(name => name.startsWith('data-pi-click-dispatch-')) })",
								});
								assert.deepEqual(getResultValue(readRecord(residue.details), ["result"]), {
									markers: [],
									attributes: [],
								});
							},
						);
						await t.test("smooth-scroll containers report success after moving", async () => {
							await call({ args: ["scroll", "#panel", "down", "300"] });
							const position = await call({
								args: ["eval", "document.querySelector('#panel').scrollTop"],
							});
							assert.equal(getResultValue(readRecord(position.details), ["result"]), 300);
						});
						await t.test(
							"wrapper-filtered snapshots preserve explicit JSON and complete refs",
							async () => {
								const control = await call({ args: ["--json", "snapshot", "-i"] });
								assert.equal(readRecord(JSON.parse(resultText(control))).success, true);
								const result = await call({
									args: ["--json", "snapshot", "-i", "--filter", "role=button"],
								});
								const envelope = readRecord(JSON.parse(resultText(result)));
								assert.equal(envelope.success, true);
								const { lifecycle, ...visibleData } = readRecord(readRecord(result.details).data);
								assert.ok(
									typeof lifecycle === "object" && lifecycle !== null,
									"native lifecycle remains in audit details",
								);
								assert.deepEqual(envelope.data, visibleData);
								const visibleRefs = Object.values(readRecord(readRecord(envelope.data).refs)).map(
									readRecord,
								);
								assert.ok(visibleRefs.length > 0, "filter must retain actual fixture buttons");
								assert.ok(visibleRefs.some((ref) => ref.role === "button" && ref.name === "Save"));
								assert.ok(visibleRefs.every((ref) => ref.role === "button"));
								assert.ok(
									Object.values(
										readRecord(readRecord(readRecord(result.details).refSnapshot).refs),
									).some((ref) => readRecord(ref).role === "link"),
								);
								const failure = await executeRegisteredTool(h.tool, h.ctx, {
									args: ["--json", "scroll", "#missing-panel", "down", "300"],
								});
								assert.equal(failure.isError, true);
								assert.equal(readRecord(JSON.parse(resultText(failure))).success, false);
							},
						);
					} finally {
						await call({ args: ["close"] });
						await runExtensionEvent(h.handlers, "session_shutdown", { reason: "quit" }, h.ctx);
					}
				},
			);
		} finally {
			await fixture.close();
			await rm(dir, { recursive: true, force: true });
			await rm(socketDir, { recursive: true, force: true });
		}
	},
);

test(
	"real upstream agent-browser contract suite matches duplicate-name click mutation",
	{
		skip: REAL_UPSTREAM_ENABLED ? false : REAL_UPSTREAM_SKIP_REASON,
		timeout: 60_000,
	},
	async (t) => {
		await assertInstalledAgentBrowserVersion();
		const tempDir = await mkdtemp(join(tmpdir(), "dp-"));
		const socketDir = createShortPrivateSocketDir(tempDir);
		const fixture = await startAgentBrowserContractFixtureServer();
		try {
			await withPatchedEnv(
				{
					HOME: tempDir,
					USERPROFILE: tempDir,
					AGENT_BROWSER_CONFIG: undefined,
					AGENT_BROWSER_SOCKET_DIR: socketDir,
					PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					try {
						const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["open", `${fixture.baseUrl}/duplicate-buttons`],
							sessionMode: "fresh",
						});
						assert.equal(opened.isError, false, resultText(opened));
						const sessionName = readString(readRecord(opened.details).sessionName);
						const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["snapshot", "-i"],
						});
						assert.equal(snapshot.isError, false, resultText(snapshot));
						const refSnapshot = readRefSnapshot(readRecord(snapshot.details).refSnapshot);
						const duplicates = Object.entries(refSnapshot.refs).filter(
							([, ref]) => ref.role === "button" && ref.name === "Add to cart",
						);
						assert.equal(duplicates.length, 2);
						const first = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["click", "xpath=//*[@id='first']"],
						});
						assert.equal(first.isError, false, resultText(first));
						assert.equal(
							readRecord(readRecord(first.details).pageChangeSummary).observed,
							false,
							"native dispatch alone must not claim application-state proof",
						);

						await withOwnedManagedSessionContext(
							{ cwd: tempDir, sessionName, restoreState: new ManagedSessionRestoreState() },
							async () => {
								// The first button is now Remove: its old name's ordinal points at the untouched second button.
								const probe = await prepareClickDispatchProbe({
									commandTokens: ["click", `@${duplicates[0][0]}`],
									cwd: tempDir,
									refSnapshot,
									sessionName,
								});
								const nativeClick = await runAgentBrowserProcess({
									args: ["--json", "--session", sessionName, "click", "xpath=//*[@id='first']"],
									cwd: tempDir,
								});
								assert.equal(nativeClick.exitCode, 0, nativeClick.stderr);
								assert.equal(readRecord(JSON.parse(nativeClick.stdout)).success, true);
								const diagnostic = await collectClickDispatchDiagnostic({
									cwd: tempDir,
									probe,
									sessionName,
								});
								const state = await executeRegisteredTool(harness.tool, harness.ctx, {
									args: ["eval", "--stdin"],
									stdin:
										"Array.from(document.querySelectorAll('button'), b => ({ id: b.id, text: b.textContent, clicks: Number(b.dataset.clicks || 0), trusted: b.dataset.trusted === 'true' }))",
								});
								assert.equal(state.isError, false, resultText(state));
								const buttons = getResultValue(readRecord(state.details), ["result"]);
								assert.deepEqual(buttons, [
									{ id: "first", text: "Remove", clicks: 2, trusted: true },
									{ id: "second", text: "Add to cart", clicks: 0, trusted: false },
								]);
								t.diagnostic(JSON.stringify({ buttons, clickDispatch: diagnostic }));
								assert.equal(
									diagnostic,
									undefined,
									"a stale duplicate ordinal must not contradict the native target's trusted clicks",
								);

								const probeOptions = {
									commandTokens: ["click", "xpath=//*[@id='second']"],
									cwd: tempDir,
									sessionName,
								};
								const missedProbe = await prepareClickDispatchProbe(probeOptions);
								assert.ok(missedProbe, "an exact XPath target must still be probed");
								const miss = await collectClickDispatchDiagnostic({
									...probeOptions,
									probe: missedProbe,
								});
								assert.equal(
									miss?.status,
									"no-native-event-observed",
									"no click must remain a real dispatch miss",
								);
								const hitProbe = await prepareClickDispatchProbe(probeOptions);
								assert.ok(hitProbe);
								const hit = await runAgentBrowserProcess({
									args: ["--json", "--session", sessionName, ...probeOptions.commandTokens],
									cwd: tempDir,
								});
								assert.equal(hit.exitCode, 0, hit.stderr);
								assert.equal(readRecord(JSON.parse(hit.stdout)).success, true);
								assert.equal(
									await collectClickDispatchDiagnostic({ ...probeOptions, probe: hitProbe }),
									undefined,
									"a trusted native click must not report a miss",
								);
							},
						);
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
			await fixture.close();
			await rm(socketDir, { recursive: true, force: true });
			await rm(tempDir, { recursive: true, force: true });
		}
	},
);

test(
	"real upstream agent-browser contract suite matches cold URL reopen after quit",
	{
		skip: REAL_UPSTREAM_ENABLED ? false : REAL_UPSTREAM_SKIP_REASON,
		timeout: 60_000,
	},
	async (t) => {
		await assertInstalledAgentBrowserVersion();
		for (const storage of [false, true]) {
			// Subtests own process-global env overrides until native-session teardown completes.
			// oxlint-disable-next-line no-await-in-loop
			await t.test(
				storage ? "origin storage at a non-root URL" : "empty storage at a non-root URL",
				async (subtest) => {
					const tempDir = await mkdtemp(join(tmpdir(), "cr-"));
					const cwd = join(tempDir, "g");
					const home = join(tempDir, "h");
					const socketDir = createShortPrivateSocketDir(tempDir);
					const sessionFile = join(tempDir, "branch.json");
					const fixture = await startAgentBrowserContractFixtureServer();
					try {
						await Promise.all(
							[cwd, home, socketDir].map((path) => mkdir(path, { mode: 0o700, recursive: true })),
						);
						await initializeGitProject(cwd);
						await withPatchedEnv(
							{
								HOME: home,
								USERPROFILE: home,
								AGENT_BROWSER_CONFIG: undefined,
								// Automatic restore requires a default launch, not a caller executable override.
								AGENT_BROWSER_EXECUTABLE_PATH: undefined,
								AGENT_BROWSER_ENCRYPTION_KEY:
									process.platform === "win32" ? "a".repeat(64) : undefined,
								AGENT_BROWSER_SOCKET_DIR: socketDir,
								PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
								PI_AGENT_BROWSER_MANAGED_SESSION_RESTORE: undefined,
							},
							async () => {
								const url = `${fixture.baseUrl}/contract?cold=${storage ? "storage" : "empty"}`;
								const branch: unknown[] = [];
								let harness = createExtensionHarness({ branch, cwd, sessionFile });
								let sessionName: string | undefined;
								const observe = async (args: readonly string[]) => {
									assert.ok(sessionName !== undefined && sessionName.length > 0);
									const result = await executeRegisteredTool(harness.tool, harness.ctx, {
										args: ["--namespace", "", "--session", sessionName, ...args],
									});
									assert.equal(readRecord(result.details).exitCode, 0, resultText(result));
									assert.equal(result.isError, false, resultText(result));
									return readRecord(readRecord(result.details).data);
								};
								const run = async (params: Parameters<typeof executeRegisteredTool>[2]) => {
									const result = await executeRegisteredTool(harness.tool, harness.ctx, params);
									branch.push(
										createToolBranchEntry({
											details: readRecord(result.details),
											isError: result.isError,
										}),
									);
									return result;
								};
								try {
									await runExtensionEvent(
										harness.handlers,
										"session_start",
										{ reason: "new" },
										harness.ctx,
									);
									const opened = await run({ args: ["open", url], sessionMode: "fresh" });
									sessionName = readString(readRecord(opened.details).sessionName);
									assert.equal(opened.isError, false, resultText(opened));
									assert.equal(readRecord(opened.details).managedSessionRestoreDisabled, undefined);
									const seeded = await run({
										args: ["eval", "--stdin"],
										stdin: `document.body.insertAdjacentHTML('beforeend', '<button>Unsaved control</button>'); document.querySelector('#name-input').value = 'unsaved'; window.coldReopenMemory = true; ${storage ? "localStorage.setItem('cold-reopen', 'kept'); sessionStorage.setItem('cold-reopen', 'kept');" : ""} true`,
									});
									assert.equal(seeded.isError, false, resultText(seeded));
									const before = await run({ args: ["snapshot", "-i"] });
									assert.equal(before.isError, false, resultText(before));
									assert.match(
										JSON.stringify(readRecord(before.details).refSnapshot),
										/Unsaved control/,
									);
									const framed = await run({ args: ["frame", "#contract-frame"] });
									assert.equal(framed.isError, false, resultText(framed));
									const oldDaemon = await observe(["session", "info"]);
									assert.equal(typeof oldDaemon.pid, "number");
									await runExtensionEvent(
										harness.handlers,
										"session_shutdown",
										{ reason: "quit" },
										harness.ctx,
									);
									assert.equal(
										await waitForTestPidExit(readNumber(oldDaemon.pid), 10_000),
										true,
										"old owned daemon must exit before the first resumed read",
									);
									assert.equal((await observe(["session", "info"])).active, false);
									await writeFile(sessionFile, JSON.stringify(branch));
									harness = createExtensionHarness({
										branch: readArray(JSON.parse(await readFile(sessionFile, "utf8"))),
										cwd,
										sessionFile,
									});
									await runExtensionEvent(
										harness.handlers,
										"session_start",
										{ reason: "resume" },
										harness.ctx,
									);

									// No explicit open after quit: the first requested operation must read the remembered page.
									const snapshot = await run({ args: ["snapshot", "-i"] });
									const observed = await observe(["get", "url"]);
									const newDaemon = await observe(["session", "info"]);
									subtest.diagnostic(
										JSON.stringify({
											storage,
											sessionName,
											oldPid: oldDaemon.pid,
											oldDaemonExited: true,
											newPid: newDaemon.pid,
											restoreStatus: readRecord(newDaemon.runtime).restoreStatus,
											requestedUrl: url,
											observedUrl: observed.url,
											resultCategory: readRecord(snapshot.details).resultCategory,
											failureCategory: readRecord(snapshot.details).failureCategory,
										}),
									);
									assert.equal(snapshot.isError, false, resultText(snapshot));
									assert.equal(readRecord(snapshot.details).resultCategory, "success");
									assert.equal(readRecord(snapshot.details).sessionName, sessionName);
									assert.equal(observed.url, url);
									assert.equal(readRecord(readRecord(snapshot.details).data).origin, url);
									assert.equal(readRecord(readRecord(snapshot.details).sessionTabTarget).url, url);
									assert.equal(readRecord(newDaemon.runtime).restoreStatus, "loaded");
									assert.notEqual(newDaemon.pid, oldDaemon.pid);
									assert.equal(readRecord(snapshot.details).refSnapshotInvalidation, undefined);
									assert.match(
										JSON.stringify(readRecord(snapshot.details).refSnapshot),
										/"name":"Name"/,
									);
									assert.doesNotMatch(
										JSON.stringify(readRecord(snapshot.details).refSnapshot),
										/Unsaved control/,
									);
									const state = await run({
										args: ["eval", "--stdin"],
										stdin:
											"JSON.stringify({ local: localStorage.getItem('cold-reopen'), session: sessionStorage.getItem('cold-reopen'), form: document.querySelector('#name-input').value, memory: typeof window.coldReopenMemory })",
									});
									assert.equal(state.isError, false, resultText(state));
									assert.deepEqual(
										JSON.parse(readString(getResultValue(readRecord(state.details), ["result"]))),
										{
											local: storage ? "kept" : null,
											session: storage ? "kept" : null,
											form: "",
											memory: "undefined",
										},
									);
								} finally {
									if (sessionName !== undefined && sessionName.length > 0) {
										const daemon = await observe(["session", "info"]);
										await runExtensionEvent(
											harness.handlers,
											"session_shutdown",
											{ reason: "quit" },
											harness.ctx,
										);
										// Every initialized fixture must reap its daemon; failed initialization already fails the test.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal(
											await waitForTestPidExit(
												daemon.pid === undefined || daemon.pid === null
													? undefined
													: readNumber(daemon.pid),
												10_000,
											),
											true,
											"final owned daemon must exit",
										);
										// Every initialized fixture must leave native ownership inactive after shutdown.
										// oxlint-disable-next-line node-test/no-conditional-assertion
										assert.equal((await observe(["session", "info"])).active, false);
										subtest.diagnostic(
											JSON.stringify({ sessionName, cleanup: "closed", daemonExited: true }),
										);
									}
								}
							},
						);
					} finally {
						await fixture.close();
						await rm(socketDir, { recursive: true, force: true });
						await rm(tempDir, { recursive: true, force: true });
					}
				},
			);
		}
	},
);

test(
	"real upstream agent-browser contract suite matches 0.38 observation and recording options",
	{ skip: !REAL_UPSTREAM_ENABLED, timeout: 120_000 },
	async (t) => {
		const version = await assertInstalledAgentBrowserVersion();
		const [major, minor] = version.split(".").map(Number);
		if (major === 0 && minor < 38) {
			t.skip("Observation options require upstream 0.38+");
			return;
		}
		const dir = await mkdtemp(join(tmpdir(), "piab-038-"));
		const socketDir = join(dir, "s");
		await mkdir(socketDir, { mode: 0o700 });
		const fixture = await startAgentBrowserContractFixtureServer();
		const session = `rebaseline-${process.pid}`;
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
					await runExtensionEvent(h.handlers, "session_start", { reason: "new" }, h.ctx);
					const call = async (args: readonly string[], stdin?: string) => {
						const result = await executeRegisteredTool(h.tool, h.ctx, {
							args: ["--session", session, ...args],
							stdin,
						});
						assert.equal(result.isError, false, `${args.join(" ")}: ${resultText(result)}`);
						return result;
					};
					const snapshotOf = (value: unknown) =>
						readRecord(getResultValue(readRecord(readRecord(value).details), ["snapshot"]));
					try {
						await call(["open", `${fixture.baseUrl}/contract`]);
						const full = await call(["snapshot", "-i", "--delta"]);
						assert.equal(snapshotOf(full).kind, "full");
						const ref = Object.entries(readRecord(snapshotOf(full).refs)).find(
							([, value]) => readRecord(value).name === "Mark ready",
						)?.[0];
						assert.ok(ref !== undefined && ref.length > 0);
						const unchanged = await call(["snapshot", "-i", "--delta"]);
						assert.equal(snapshotOf(unchanged).kind, "unchanged");
						assert.ok(
							readArray(readRecord(readRecord(unchanged.details).refSnapshot).refIds).includes(ref),
						);
						await call(["--input-mode", "smooth", "click", `@${ref}`, "--human"]);
						assert.equal(
							getResultValue((await call(["get", "text", "#status"])).details ?? {}, ["text"]),
							"Clicked",
						);
						const fresh = await call(["snapshot", "-i", "--delta", "--full"]);
						assert.equal(snapshotOf(fresh).kind, "full");
						assert.ok(
							Object.hasOwn(readRecord(snapshotOf(fresh).refs), ref),
							"same DOM node keeps its ref",
						);
						const batched = await call(
							["batch", "--bail"],
							JSON.stringify([
								["snapshot", "-i", "--delta"],
								["get", "url"],
							]),
						);
						assert.ok(
							readArray(readRecord(readRecord(batched.details).refSnapshot).refIds).includes(ref),
						);
						await call(["get", "text", `@${ref}`]);
						const filtered = await call(["snapshot", "-i", "--delta", "--search", "Mark ready"]);
						assert.match(resultText(filtered), /Mark ready/);

						await call(
							["eval", "--stdin"],
							"for (let i = 0; i < 80; i++) { const b = document.createElement('button'); b.textContent = 'Observation control ' + i; document.body.append(b); }",
						);
						await call(["snapshot", "-i", "--delta", "--full"]);
						await call(
							["eval", "--stdin"],
							"document.getElementById('mark-ready').textContent = 'Ready again'",
						);
						const delta = await call(["snapshot", "-i", "--delta"]);
						assert.equal(snapshotOf(delta).kind, "delta");
						assert.match(JSON.stringify(snapshotOf(delta).changes), /Ready again/);
						assert.ok(
							readArray(readRecord(readRecord(delta.details).refSnapshot).refIds).includes(ref),
						);
						await call(["get", "text", `@${ref}`]);

						await call(["screenshot", "--if-changed", "shots/first.png"]);
						const suppressed = await call(["screenshot", "--threshold", "0", "shots/absent.png"]);
						assert.equal(getResultValue(suppressed.details ?? {}, ["changed"]), false);
						assert.equal(readRecord(readRecord(suppressed.details).data).path, undefined);
						assert.equal(
							suppressed.content.some((item) => item.type === "image"),
							false,
						);
						await assert.rejects(readFile(join(dir, "shots/absent.png")), { code: "ENOENT" });
						const raw = await call(["batch", "screenshot --if-changed shots/raw-absent.png"]);
						assert.equal(
							readRecord(readRecord(readArray(readRecord(raw.details).data)[0]).result).changed,
							false,
						);
						assert.equal(
							readRecord(raw.details).artifacts === undefined
								? 0
								: readArray(readRecord(raw.details).artifacts).length,
							0,
						);
						await assert.rejects(readFile(join(dir, "shots/raw-absent.png")), { code: "ENOENT" });

						await call([
							"auth",
							"save",
							"fixture",
							"--url",
							`${fixture.baseUrl}/contract`,
							"--username",
							"demo",
							"--password",
							"fixture-only",
						]);
						assert.equal(
							getResultValue((await call(["get", "url"])).details ?? {}, ["url"]),
							`${fixture.baseUrl}/contract`,
							"local auth save must not reconfigure the caller's browser launch or lose its HTTP page",
						);
						await call(
							["eval", "--stdin"],
							"document.body.insertAdjacentHTML('beforeend', '<input id=login-user><input id=login-pass type=password><button id=login-submit type=button>Log in</button>'); document.querySelector('#login-submit').onclick = () => { document.body.dataset.loggedIn = document.querySelector('#login-user').value + ':' + document.querySelector('#login-pass').value; }",
						);
						await call([
							"auth",
							"login",
							"fixture",
							"--no-navigate",
							"--username-selector",
							"#login-user",
							"--password-selector",
							"#login-pass",
							"--submit-selector",
							"#login-submit",
						]);
						assert.equal(
							getResultValue(
								(await call(["eval", "--stdin"], "document.body.dataset.loggedIn")).details ?? {},
								["result"],
							),
							"demo:fixture-only",
						);

						const collision = await executeRegisteredTool(h.tool, h.ctx, {
							args: ["--session", session, "batch"],
							stdin:
								'[["record","start","collision.webm","--contact-sheet"],["screenshot","collision.contact-sheet.png"]]',
						});
						assert.equal(collision.isError, true);
						assert.match(resultText(collision), /already written by step/);
						await call([
							"record",
							"start",
							"capture.webm",
							"--cursor",
							"--contact-sheet-threshold",
							"0.01",
						]);
						const reserved = await executeRegisteredTool(h.tool, h.ctx, {
							args: ["--session", session, "screenshot", "capture.contact-sheet.png"],
						});
						assert.equal(reserved.isError, true);
						assert.match(resultText(reserved), /reserved by an active recording/);
						await call([
							"mouse",
							"move",
							"200",
							"250",
							"--duration",
							"250",
							"--steps",
							"12",
							"--human",
							"--seed",
							"42",
						]);
						await call(["eval", "--stdin"], "document.body.style.background = 'lightblue'");
						await call(["wait", "1500"]);
						const stopped = await call(["record", "stop"]);
						const sheet = readArray(readRecord(stopped.details).artifacts)
							.map(readRecord)
							.find((artifact) => artifact.kind === "image");
						assert.ok(sheet);
						assert.equal(sheet.status, "saved");
						assert.equal(
							(await readFile(join(dir, "capture.contact-sheet.png")))
								.subarray(0, 8)
								.toString("hex"),
							"89504e470d0a1a0a",
						);
						assert.ok((await readFile(join(dir, "capture.webm"))).length > 0);
						assert.equal(
							stopped.content.some((item) => item.type === "image"),
							true,
						);
					} finally {
						await closeManagedSessionIfPresent({ cwd: dir, sessionName: session, socketDir });
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
	"real upstream auth profiles are global while login uses the active managed browser",
	{ skip: !REAL_UPSTREAM_ENABLED && REAL_UPSTREAM_SKIP_REASON, timeout: 60_000 },
	async () => {
		await assertInstalledAgentBrowserVersion();
		// The cwd basename contributes to the managed name; leave room for the native namespace/socket suffix.
		const dir = await mkdtemp(join(tmpdir(), "a-"));
		const socketDir = createShortPrivateSocketDir(dir);
		// Native Windows pipes are namespace/session-scoped, not socket-directory-scoped.
		const namespace = randomBytes(5).toString("hex");
		const fixture = await startAgentBrowserContractFixtureServer();
		let managedSessionName: string | undefined;
		try {
			await withPatchedEnv(
				{
					HOME: dir,
					USERPROFILE: dir,
					PI_CODING_AGENT_DIR: join(dir, "pi"),
					PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_CONFIG: undefined,
					AGENT_BROWSER_ENCRYPTION_KEY: undefined,
					AGENT_BROWSER_SESSION: undefined,
					AGENT_BROWSER_SESSION_NAME: undefined,
					AGENT_BROWSER_NAMESPACE: namespace,
					AGENT_BROWSER_PROFILE: undefined,
					AGENT_BROWSER_RESTORE: undefined,
					AGENT_BROWSER_CDP: undefined,
					AGENT_BROWSER_AUTO_CONNECT: undefined,
					AGENT_BROWSER_PROVIDER: undefined,
				},
				async () => {
					const h = createExtensionHarness({ cwd: dir, sessionFile: null });
					await runExtensionEvent(h.handlers, "session_start", { reason: "new" }, h.ctx);
					const call = async (args: readonly string[], stdin?: string) => {
						const result = await executeRegisteredTool(h.tool, h.ctx, { args, stdin });
						assert.equal(result.isError, false, `${args.join(" ")}: ${resultText(result)}`);
						return result;
					};
					const url = `${fixture.baseUrl}/contract`;
					const opened = await executeRegisteredTool(h.tool, h.ctx, {
						args: ["--namespace", namespace, "open", url],
						sessionMode: "fresh",
					});
					const attemptedSession = opened.details?.sessionName;
					managedSessionName = typeof attemptedSession === "string" ? attemptedSession : undefined;
					assert.equal(opened.isError, false, resultText(opened));
					assert.ok(managedSessionName !== undefined, "fresh open returned a managed identity");
					assert.ok(managedSessionName.startsWith("piab-"));

					const saved = await call(
						[
							"auth",
							"save",
							"fixture",
							"--url",
							url,
							"--username",
							"fixture-user",
							"--username-selector",
							"#name-input",
							"--password-selector",
							"#notes-input",
							"--submit-selector",
							"#mark-ready",
							"--password-stdin",
						],
						"fixture-only\n",
					);
					assert.equal(readArray(saved.details?.effectiveArgs).includes("--session"), false);
					const listed = await call(["auth", "list"]);
					assert.deepEqual(listed.details?.effectiveArgs, ["--json", "auth", "list"]);
					assert.deepEqual(
						readArray(getResultValue(readRecord(listed.details), ["profiles"])).map(
							(profile) => readRecord(profile).name,
						),
						["fixture"],
					);
					const shown = await call(["--session", "auth-other", "auth", "show", "fixture"]);
					assert.equal(
						readRecord(getResultValue(readRecord(shown.details), ["profile"])).username,
						"fixture-user",
					);

					const login = await call(["auth", "login", "fixture"]);
					assert.equal(login.details?.usedImplicitSession, true);
					assert.equal(login.details.sessionName, managedSessionName);
					const applied = await call(
						["eval", "--stdin"],
						"document.querySelector('#name-input').value === 'fixture-user' && " +
							"document.querySelector('#notes-input').value === 'fixture-only' && " +
							"document.body.dataset.clicked === 'yes'",
					);
					assert.equal(getResultValue(readRecord(applied.details), ["result"]), true);
					const removed = await call(["auth", "remove", "fixture"]);
					assert.deepEqual(removed.details?.effectiveArgs, ["--json", "auth", "remove", "fixture"]);
					const empty = await call(["--session", "auth-other", "auth", "list"]);
					assert.deepEqual(getResultValue(readRecord(empty.details), ["profiles"]), []);
				},
			);
		} finally {
			await closeManagedSessionIfPresent({
				cwd: dir,
				sessionName: managedSessionName,
				socketDir,
				namespace,
			});
			await closeManagedSessionIfPresent({
				cwd: dir,
				sessionName: "auth-other",
				socketDir,
				namespace,
			});
			await closeManagedSessionIfPresent({
				cwd: dir,
				sessionName: "default",
				socketDir,
				namespace,
			});
			await fixture.close();
			await rm(socketDir, { recursive: true, force: true });
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test(
	"real upstream agent-browser contract suite matches wrapper and browser-session expectations",
	{
		skip: REAL_UPSTREAM_ENABLED ? false : REAL_UPSTREAM_SKIP_REASON,
		timeout: 180_000,
	},
	async () => {
		const installedVersion = await assertInstalledAgentBrowserVersion();
		const shapes = await readOutputShapesFixture();
		assert.equal(
			shapes.targetVersion,
			CAPABILITY_BASELINE.targetVersion,
			"output-shape fixture must track the canonical target version",
		);

		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-real-upstream-"));
		const socketDir = await mkdtemp(
			join(dirname(getAgentBrowserSocketDir() ?? join(tmpdir(), "piab")), "ru-"),
		);
		const downloadDir = join(tempDir, "Downloads");
		await initializeGitProject(tempDir);
		await mkdir(downloadDir, { recursive: true });
		let fixtureServer: FixtureServer | undefined;
		let managedSessionName: string | undefined;
		try {
			fixtureServer = await startAgentBrowserContractFixtureServer();
			const fixtureBaseUrl = fixtureServer.baseUrl;
			await withPatchedEnv(
				{
					AGENT_BROWSER_DOWNLOAD_PATH: downloadDir,
					AGENT_BROWSER_SOCKET_DIR: socketDir,
					PI_AGENT_BROWSER_SOCKET_DIR: socketDir,
					AGENT_BROWSER_SCREENSHOT_DIR: join(tempDir, "screenshots"),
					// Profile continuity and automatic restore exercise default native launch policy.
					AGENT_BROWSER_EXECUTABLE_PATH: undefined,
					HOME: tempDir,
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const contractUrl = `${fixtureBaseUrl}/contract`;

					await withPatchedEnv(
						{ AGENT_BROWSER_DOWNLOAD_PATH: undefined, AGENT_BROWSER_SCREENSHOT_DIR: undefined },
						async () => {
							const profileHarness = createExtensionHarness({
								cwd: tempDir,
								sessionId: "12345678123456781234567812345678",
							});
							await runExtensionEvent(
								profileHarness.handlers,
								"session_start",
								{ reason: "new" },
								profileHarness.ctx,
							);
							await mkdir(join(tempDir, "profile-continuity"));
							try {
								const profileOpen = await executeRegisteredTool(
									profileHarness.tool,
									profileHarness.ctx,
									{
										args: [
											"--profile",
											join(tempDir, "profile-continuity"),
											"--user-agent",
											"Profile Continuity/1",
											"open",
											contractUrl,
										],
										sessionMode: "fresh",
									},
								);
								assertSuccessfulResult(
									profileOpen,
									shapes.commands.open,
									"profile continuity open",
								);
								const profileUrl = await executeRegisteredTool(
									profileHarness.tool,
									profileHarness.ctx,
									{ args: ["get", "url"] },
								);
								const profileUrlDetails = assertSuccessfulResult(
									profileUrl,
									shapes.commands.coreSubcommand,
									"profile continuity get url",
								);
								assert.equal(
									readRecord(profileUrlDetails.data).url,
									contractUrl,
									"profile and user-agent launch settings must not be re-emitted on active follow-ups",
								);
							} finally {
								await executeRegisteredTool(profileHarness.tool, profileHarness.ctx, {
									args: ["close"],
								});
							}
						},
					);

					const version = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--version"],
					});
					const versionDetails = assertSuccessfulResult(
						version,
						shapes.commands.version,
						"--version",
					);
					assert.equal(versionDetails.stdout, `agent-browser ${installedVersion}`);
					assert.equal(versionDetails.inspection, true);
					assert.deepEqual(versionDetails.effectiveArgs, ["--version"]);

					const rootHelp = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--help"],
					});
					const rootHelpDetails = assertSuccessfulResult(
						rootHelp,
						shapes.commands.rootHelp,
						"--help",
					);
					assert.equal(rootHelpDetails.inspection, true);
					assert.deepEqual(rootHelpDetails.effectiveArgs, ["--help"]);
					assert.match(resultText(rootHelp), /Usage: agent-browser/);

					const commandHelp = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "--help"],
					});
					const commandHelpDetails = assertSuccessfulResult(
						commandHelp,
						shapes.commands.commandHelp,
						"snapshot --help",
					);
					assert.equal(commandHelpDetails.inspection, true);
					assert.deepEqual(commandHelpDetails.effectiveArgs, ["snapshot", "--help"]);
					assert.match(resultText(commandHelp), /snapshot/);

					const skillsList = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["skills", "list"],
					});
					const skillsListDetails = assertSuccessfulResult(
						skillsList,
						shapes.commands.skillsList,
						"skills list",
					);
					assert.equal(skillsListDetails.sessionName, undefined);
					assert.equal(skillsListDetails.usedImplicitSession, undefined);
					assert.deepEqual(skillsListDetails.effectiveArgs, ["--json", "skills", "list"]);
					assert.match(resultText(skillsList), /core/);
					if (installedVersion === CAPABILITY_BASELINE.targetVersion) {
						// The sampled native release owns this skill; all versions check core skills above.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(resultText(skillsList), /webmcp-gen/);
					}

					const skillsGetFull = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["skills", "get", "core", "--full"],
					});
					const skillsGetFullDetails = assertSuccessfulResult(
						skillsGetFull,
						shapes.commands.skillsGetFull,
						"skills get core --full",
					);
					assert.equal(skillsGetFullDetails.sessionName, undefined);
					assert.equal(skillsGetFullDetails.usedImplicitSession, undefined);
					assert.deepEqual(skillsGetFullDetails.effectiveArgs, [
						"--json",
						"skills",
						"get",
						"core",
						"--full",
					]);
					assert.match(resultText(skillsGetFull), /agent_browser/);

					const protectedVercelSkill = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["skills", "get", "protected-vercel-deployments", "--full"],
					});
					const protectedVercelDetails = assertSuccessfulResult(
						protectedVercelSkill,
						shapes.commands.skillsGetFull,
						"skills get protected-vercel-deployments --full",
					);
					assert.equal(protectedVercelDetails.sessionName, undefined);
					assert.match(resultText(protectedVercelSkill), /x-vercel-trusted-oidc-idp-token/);

					if (installedVersion === CAPABILITY_BASELINE.targetVersion) {
						const webMcpSkill = await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["skills", "get", "webmcp-gen", "--full"],
						});
						const webMcpSkillDetails = assertSuccessfulResult(
							webMcpSkill,
							shapes.commands.skillsGetFull,
							"skills get webmcp-gen --full",
						);
						// The sampled-release WebMCP skill must retain native sessionless inspection.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(webMcpSkillDetails.sessionName, undefined);
						// The sampled-release skill must expose its native setup instructions.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(resultText(webMcpSkill), /webmcp\.init\.js/);
					}

					const skillsPath = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["skills", "path", "core"],
					});
					const skillsPathDetails = assertSuccessfulResult(
						skillsPath,
						shapes.commands.skillsPath,
						"skills path core",
					);
					assert.equal(skillsPathDetails.sessionName, undefined);
					assert.equal(skillsPathDetails.usedImplicitSession, undefined);
					assert.deepEqual(skillsPathDetails.effectiveArgs, ["--json", "skills", "path", "core"]);
					assert.match(resultText(skillsPath), /core/);

					const webMcpUrl = `${fixtureBaseUrl}/webmcp`;
					if (installedVersion === CAPABILITY_BASELINE.targetVersion) {
						const disabledHarness = createExtensionHarness({
							cwd: tempDir,
							sessionId: "87654321876543218765432187654321",
						});
						await runExtensionEvent(
							disabledHarness.handlers,
							"session_start",
							{ reason: "new" },
							disabledHarness.ctx,
						);
						try {
							const disabledOpen = await executeRegisteredTool(
								disabledHarness.tool,
								disabledHarness.ctx,
								{
									args: ["--no-webmcp", "open", webMcpUrl],
									sessionMode: "fresh",
								},
							);
							assertSuccessfulResult(disabledOpen, shapes.commands.open, "open with --no-webmcp");
							// Native releases supporting --no-webmcp must preserve it after successful open.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.ok(
								readArray(readRecord(disabledOpen.details).effectiveArgs).includes("--no-webmcp"),
							);
							const disabledList = await executeRegisteredTool(
								disabledHarness.tool,
								disabledHarness.ctx,
								{ args: ["webmcp", "list"] },
							);
							const disabledListDetails = assertSuccessfulResult(
								disabledList,
								shapes.commands.coreSubcommand,
								"webmcp list with feature disabled",
							);
							// Feature-disabled native variants must expose no tools after successful inspection.
							// oxlint-disable-next-line node-test/no-conditional-assertion
							assert.deepEqual(readRecord(disabledListDetails.data).tools, []);
						} finally {
							await executeRegisteredTool(disabledHarness.tool, disabledHarness.ctx, {
								args: ["close"],
							});
						}
					}

					const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", contractUrl],
						sessionMode: "fresh",
					});
					const openDetails = assertSuccessfulResult(opened, shapes.commands.open, "open");
					managedSessionName = readString(openDetails.sessionName);
					assert.ok(
						managedSessionName.length > 0,
						"fresh open should allocate a managed session name",
					);
					assert.equal(openDetails.sessionMode, "fresh");
					assert.equal(openDetails.usedImplicitSession, false);
					assert.equal(readRecord(openDetails.data).title, "Agent Browser Contract Fixture");

					const evaluated = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["eval", "--stdin"],
						stdin: "document.title",
					});
					const evalDetails = assertSuccessfulResult(
						evaluated,
						shapes.commands.eval,
						"eval --stdin",
					);
					assert.equal(evalDetails.sessionName, managedSessionName);
					assert.equal(evalDetails.usedImplicitSession, true);
					assert.equal(readRecord(evalDetails.data).origin, contractUrl);
					assert.equal(readRecord(evalDetails.data).result, "Agent Browser Contract Fixture");

					const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					const snapshotDetails = assertSuccessfulResult(
						snapshot,
						shapes.commands.snapshot,
						"snapshot -i",
					);
					assert.equal(readRecord(snapshotDetails.data).origin, contractUrl);
					assert.equal(snapshotDetails.sessionName, managedSessionName);
					assert.equal(snapshotDetails.usedImplicitSession, true);
					assertJsonIncludes(
						snapshotDetails.data,
						["Agent Browser Contract Fixture"],
						"snapshot data",
					);
					const flavorRef = readString(
						readArray(
							Object.entries(readRecord(readRecord(snapshotDetails.data).refs)).find(
								([, ref]) =>
									readRecord(ref).role === "combobox" && readRecord(ref).name === "Flavor",
							),
						)[0],
					);
					assert.ok(flavorRef.length > 0, "snapshot should expose the Flavor combobox ref");
					await runCoreCommand(
						harness,
						["select", `@${flavorRef}`, "chocolate"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "value", "#flavor-select"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["value"],
						),
						"chocolate",
					);

					if (installedVersion === CAPABILITY_BASELINE.targetVersion) {
						await runCoreCommand(
							harness,
							["open", webMcpUrl],
							shapes.commands.open,
							managedSessionName,
							"open WebMCP fixture",
						);
						const webMcpList = await runCoreCommand(
							harness,
							["webmcp", "list"],
							shapes.commands.coreSubcommand,
							managedSessionName,
						);
						// WebMCP-capable native versions must retain the inspected fixture target.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(webMcpList.sessionTabTarget).url, webMcpUrl);
						const tools = readArray(readRecord(webMcpList.data).tools).map(readRecord);
						const setMessageFrame = readString(
							readRecord(tools.find((tool) => tool.name === "set_message")).frameId,
						);
						// The native WebMCP variant must supply an executable frame identity before invocation.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.ok(
							setMessageFrame.length > 0,
							"webmcp list should expose set_message and its frame id",
						);

						const webMcpInvoke = await runCoreCommand(
							harness,
							[
								"webmcp",
								"invoke",
								"set_message",
								"--params",
								'{"message":"WebMCP changed"}',
								"--frame",
								setMessageFrame,
								"--timeout",
								"5000",
							],
							shapes.commands.coreSubcommand,
							managedSessionName,
						);
						// The native WebMCP variant must complete its real fixture invocation.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(webMcpInvoke.data).status, "completed");
						// The native WebMCP variant must retain the completed invocation target.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							readRecord(readRecord(webMcpInvoke.data).navigationSummary).url,
							webMcpUrl,
						);
						// The native WebMCP mutation variant must invalidate existing interactive refs.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							readRecord(webMcpInvoke.refSnapshotInvalidation).reason,
							"page-transition",
						);
						// The native WebMCP mutation variant must offer post-mutation inspection.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.deepEqual(
							readArray(webMcpInvoke.nextActions)
								.map(readRecord)
								.map((action) => action.id),
							["inspect-after-mutation"],
						);
						// The native WebMCP variant must actually mutate the independently served page.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							getResultValue(
								await runCoreCommand(
									harness,
									["get", "text", "#webmcp-result"],
									shapes.commands.coreSubcommand,
									managedSessionName,
								),
								["text"],
							),
							"WebMCP changed",
						);

						const detached = await runCoreCommand(
							harness,
							["webmcp", "invoke", "wait_for_cancel", "--detach"],
							shapes.commands.coreSubcommand,
							managedSessionName,
						);
						const invocationId = readString(readRecord(detached.data).invocationId);
						// The detached-invocation variant must supply a usable pending identity.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.ok(
							invocationId.length > 0,
							"detached WebMCP invoke should return an invocation id",
						);
						// The pending WebMCP variant must not retain an unverified target.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(detached.sessionTabTarget, undefined);
						// The pending WebMCP variant must explicitly mark target uncertainty.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(detached.sessionTabTargetUnknown, true);
						// The pending variant must offer target verification instead of stale snapshots.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.deepEqual(
							readArray(detached.nextActions)
								.map(readRecord)
								.map((action) => action.id),
							["verify-page-target-after-pending-webmcp"],
						);
						const canceled = await runCoreCommand(
							harness,
							["webmcp", "cancel", invocationId],
							shapes.commands.coreSubcommand,
							managedSessionName,
						);
						// The cancellation variant must acknowledge its actual pending WebMCP operation.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(canceled.data).status, "canceled");
						const canceledResult = await runCoreCommand(
							harness,
							["webmcp", "result", invocationId],
							shapes.commands.coreSubcommand,
							managedSessionName,
						);
						// The WebMCP variant must retain cancellation in its later result lookup.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(readRecord(canceledResult.data).status, "canceled");
						await runCoreCommand(
							harness,
							["open", contractUrl],
							shapes.commands.open,
							managedSessionName,
							"restore contract fixture after WebMCP",
						);
					}

					await runCoreCommand(
						harness,
						["fill", "#name-input", "read preserves this page"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					const readOutputPath = join(tempDir, "read-output.json");
					const readResult = await withPatchedEnv(
						{
							AGENT_BROWSER_SESSION: undefined,
							AGENT_BROWSER_NAMESPACE: undefined,
							PI_AGENT_BROWSER_SOCKET_DIR: undefined,
						},
						async () => {
							try {
								return await executeRegisteredTool(harness.tool, harness.ctx, {
									args: ["read", contractUrl],
									outputPath: readOutputPath,
								});
							} finally {
								// Legacy native URL reads may leave a browserless default daemon in this isolated socket directory.
								await closeManagedSessionIfPresent({
									cwd: tempDir,
									sessionName: "default",
									socketDir,
								});
							}
						},
					);
					const readDetails = assertSuccessfulResult(readResult, shapes.commands.read, "read URL");
					assert.equal(readDetails.sessionName, undefined);
					assert.equal(readDetails.usedImplicitSession, undefined);
					assert.equal(readDetails.agentBrowserStarted, true);
					const readData = readRecord(readDetails.data);
					const nativeReadLaunch =
						readData.lifecycle === undefined
							? undefined
							: readRecord(readRecord(readData.lifecycle).effectiveLaunch).browserLaunched;
					assert.deepEqual(
						readDetails.lifecycle,
						typeof nativeReadLaunch === "boolean"
							? { effectiveLaunch: { browserLaunched: nativeReadLaunch } }
							: undefined,
						"forward native launch evidence without inventing it for HTTP reads",
					);
					assert.equal(readDetails.readSource, readData.source);
					assert.equal(readDetails.managedSessionOutcome, undefined);
					assert.equal(readRecord(readDetails.outputFile).status, "saved");
					assert.match(resultText(readResult), /Agent Browser Contract Fixture/);
					assert.match(readString(readData.content), /Ready for real upstream contract validation/);
					const savedRead = readRecord(JSON.parse(await readFile(readOutputPath, "utf8")));
					assert.match(
						readString(savedRead.content),
						/Ready for real upstream contract validation/,
					);
					assert.equal(savedRead.source, readDetails.readSource);
					const ownedPageAfterRead = await runCoreCommand(
						harness,
						["get", "url"],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					assert.equal(getResultValue(ownedPageAfterRead, ["url", "result"]), contractUrl);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "value", "#name-input"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["value"],
						),
						"read preserves this page",
					);

					const uploadPath = join(tempDir, "upload-fixture.txt");
					const screenshotPath = join(tempDir, "contract.png");
					const pdfPath = join(tempDir, "contract.pdf");
					await writeFile(uploadPath, "upload contract fixture\n");

					await runCoreCommand(
						harness,
						["click", "#mark-ready"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "text", "#status"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["text"],
						),
						"Clicked",
					);
					await runCoreCommand(
						harness,
						["dblclick", "#double-action"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "text", "#status"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["text"],
						),
						"Double clicked",
					);
					await runCoreCommand(
						harness,
						["fill", "#name-input", "Ada"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["type", "#name-input", " Lovelace"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "value", "#name-input"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["value"],
						),
						"Ada Lovelace",
					);
					await runCoreCommand(
						harness,
						["type", "#name-input", "Curie", "--clear", "--delay", "1"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "value", "#name-input"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["value"],
						),
						"Curie",
					);
					await runCoreCommand(
						harness,
						["focus", "#notes-input"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["keyboard", "type", "keyboard text"],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["keyboard", "inserttext", " inserted"],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "value", "#notes-input"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["value"],
						),
						"keyboard text inserted",
					);
					await runCoreCommand(
						harness,
						["press", "Tab"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["hover", "#hover-target"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["eval", "document.body.dataset.hovered"],
								shapes.commands.eval,
								managedSessionName,
							),
							["result"],
						),
						"yes",
					);
					await runCoreCommand(
						harness,
						["check", "#agree-checkbox"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["is", "checked", "#agree-checkbox"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["checked"],
						),
						true,
					);
					await runCoreCommand(
						harness,
						["uncheck", "#agree-checkbox"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["is", "checked", "#agree-checkbox"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["checked"],
						),
						false,
					);
					await runCoreCommand(
						harness,
						["select", "#flavor-select", "chocolate"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "value", "#flavor-select"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["value"],
						),
						"chocolate",
					);
					const missingSelectOption = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["select", "#flavor-select", "mint"],
					});
					assert.equal(
						missingSelectOption.isError,
						true,
						`select should fail when no option matches: ${resultText(missingSelectOption)}`,
					);
					assert.match(resultText(missingSelectOption), /option|mint/i);
					const semanticSelect = await executeRegisteredTool(harness.tool, harness.ctx, {
						semanticAction: { action: "select", selector: "#flavor-select", value: "vanilla" },
					});
					assertCoreCommandResult(
						semanticSelect,
						shapes.commands.coreCommand,
						"semanticAction select",
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "value", "#flavor-select"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["value"],
						),
						"vanilla",
					);
					const batchSelect = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch", "--bail"],
						stdin: JSON.stringify([["select", "#flavor-select", "chocolate"]]),
					});
					assertCoreCommandResult(
						batchSelect,
						shapes.commands.batch,
						"batch select",
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "value", "#flavor-select"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["value"],
						),
						"chocolate",
					);
					await runCoreCommand(
						harness,
						["upload", "#file-input", uploadPath],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["eval", "document.querySelector('#file-input').files[0]?.name"],
								shapes.commands.eval,
								managedSessionName,
							),
							["result"],
						),
						"upload-fixture.txt",
					);
					await runCoreCommand(
						harness,
						["drag", "#drag-source", "#drop-target"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "text", "#drop-target"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["text"],
						),
						"Dropped",
					);
					await runCoreCommand(
						harness,
						["mouse", "move", "20", "20"],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["mouse", "down"],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["mouse", "up"],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["mouse", "wheel", "240"],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["scroll", "down", "400"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["click", "#far-click-target"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "text", "#status"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["text"],
						),
						"Far clicked",
					);
					await runCoreCommand(
						harness,
						["scrollintoview", "#far-target"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["wait", "#far-target"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["frame", "#contract-frame"],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["wait", "#frame-button"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["click", "#frame-button"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "text", "#frame-status"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["text"],
						),
						"Frame clicked",
					);
					await runCoreCommand(
						harness,
						["frame", "main"],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["find", "label", "Name", "fill", "Grace"],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["find", "label", "Codename", "fill", "Lovelace"],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["find", "label", "Alias Name", "fill", "Analyst"],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "value", "#name-input"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["value"],
						),
						"Grace",
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "value", "#aria-label-input"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["value"],
						),
						"Lovelace",
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "value", "#aria-labelledby-input"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["value"],
						),
						"Analyst",
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "attr", "#mark-ready", "id"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["value", "attribute"],
						),
						"mark-ready",
					);
					await runCoreCommand(
						harness,
						["get", "html", "#main"],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "count", "button"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["count"],
						),
						6,
					);
					await runCoreCommand(
						harness,
						["get", "box", "#mark-ready"],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["get", "styles", "#far-target"],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["is", "visible", "#mark-ready"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["visible"],
						),
						true,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["is", "enabled", "#mark-ready"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["enabled"],
						),
						true,
					);
					await runCoreCommand(
						harness,
						["screenshot", screenshotPath],
						shapes.commands.coreFileArtifact,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["pdf", pdfPath],
						shapes.commands.coreFileArtifact,
						managedSessionName,
					);
					assert.ok(
						readString(await readFileIfPresent(screenshotPath)).length > 0,
						"screenshot should be saved",
					);
					assert.ok(readString(await readFileIfPresent(pdfPath)).length > 0, "PDF should be saved");

					await runCoreCommand(
						harness,
						["click", "#next-link"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "title"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["title"],
						),
						"Next Contract Fixture",
					);
					await runCoreCommand(harness, ["back"], shapes.commands.coreCommand, managedSessionName);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "url"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["url"],
						),
						contractUrl,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "title"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["title"],
						),
						"Agent Browser Contract Fixture",
					);
					await runCoreCommand(
						harness,
						["forward"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "url"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["url"],
						),
						`${fixtureBaseUrl}/next`,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "title"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["title"],
						),
						"Next Contract Fixture",
					);
					await runCoreCommand(
						harness,
						["reload"],
						shapes.commands.coreCommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "url"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["url"],
						),
						`${fixtureBaseUrl}/next`,
					);
					const initialTabs = readRecord(
						(
							await runCoreCommand(
								harness,
								["tab", "list"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							)
						).data,
					);
					const initialTabId = readString(
						readRecord(
							readArray(initialTabs.tabs)
								.map(readRecord)
								.find((tab) => tab.active === true),
						).tabId,
					);
					assert.ok(initialTabId.length > 0, "tab list should expose the active tab id");
					await runCoreCommand(
						harness,
						["tab", "new", "--label", "contract-copy", contractUrl],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					await runCoreCommand(
						harness,
						["tab", initialTabId],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "url"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["url"],
						),
						`${fixtureBaseUrl}/next`,
					);
					assert.equal(
						getResultValue(
							await runCoreCommand(
								harness,
								["get", "title"],
								shapes.commands.coreSubcommand,
								managedSessionName,
							),
							["title"],
						),
						"Next Contract Fixture",
					);
					await runCoreCommand(
						harness,
						["tab", "contract-copy"],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					const tabCloseDetails = await runCoreCommand(
						harness,
						["tab", "close"],
						shapes.commands.coreSubcommand,
						managedSessionName,
					);
					assert.equal(readRecord(tabCloseDetails.sessionTabTarget).url, `${fixtureBaseUrl}/next`);
					await runCoreCommand(
						harness,
						["open", contractUrl],
						shapes.commands.open,
						managedSessionName,
					);

					const batch = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch"],
						stdin: JSON.stringify([
							["get", "text", "#status"],
							["get", "title"],
						]),
					});
					const batchDetails = assertSuccessfulResult(
						batch,
						shapes.commands.batch,
						"batch via stdin",
					);
					assert.equal(batchDetails.sessionName, managedSessionName);
					assert.equal(batchDetails.usedImplicitSession, true);
					assertJsonIncludes(
						batchDetails.data,
						["Ready for real upstream contract validation", "Agent Browser Contract Fixture"],
						"batch data",
					);

					const pushstate = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["pushstate", `${fixtureBaseUrl}/spa-route`],
					});
					const pushstateDetails = assertSuccessfulResult(
						pushstate,
						shapes.commands.pushstate,
						"pushstate",
					);
					assert.equal(pushstateDetails.sessionName, managedSessionName);
					assert.equal(pushstateDetails.usedImplicitSession, true);
					assert.equal(readRecord(pushstateDetails.data).url, `${fixtureBaseUrl}/spa-route`);

					const vitals = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["vitals", contractUrl, "--json"],
					});
					const vitalsDetails = assertSuccessfulResult(vitals, shapes.commands.vitals, "vitals");
					assert.equal(vitalsDetails.sessionName, managedSessionName);
					const vitalsData = readRecord(vitalsDetails.data);
					assert.match(readString(vitalsData.url), /\/contract\/?$/);
					assert.equal(typeof vitalsData.fcp, "number");
					assert.equal(typeof vitalsData.ttfb, "number");

					const networkRoute = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["network", "route", "**/*.js", "--abort", "--resource-type", "script"],
					});
					const networkRouteDetails = assertSuccessfulResult(
						networkRoute,
						shapes.commands.networkRoute,
						"network route --resource-type",
					);
					assert.equal(readRecord(networkRouteDetails.data).routed, "**/*.js");
					await runCoreCommand(
						harness,
						["network", "requests"],
						shapes.commands.nonCoreStatus,
						managedSessionName,
						"network requests",
					);
					await runCoreCommand(
						harness,
						["network", "har", "start"],
						shapes.commands.nonCoreStatus,
						managedSessionName,
						"network har start",
					);
					const harPath = join(tempDir, "contract.har");
					await runCoreCommand(
						harness,
						["network", "har", "stop", harPath],
						shapes.commands.nonCoreArtifact,
						managedSessionName,
						"network har stop",
					);
					assert.ok(readString(await readFileIfPresent(harPath)).length > 0, "HAR should be saved");

					await runCoreCommand(
						harness,
						["snapshot"],
						shapes.commands.snapshot,
						managedSessionName,
						"snapshot before diff",
					);
					await runCoreCommand(
						harness,
						["diff", "snapshot"],
						shapes.commands.nonCoreStatus,
						managedSessionName,
						"diff snapshot",
					);
					await runCoreCommand(
						harness,
						["diff", "screenshot", "--baseline", screenshotPath],
						shapes.commands.diffScreenshotArtifact,
						managedSessionName,
						"diff screenshot",
					);
					await runCoreCommand(
						harness,
						["diff", "url", contractUrl, `${fixtureBaseUrl}/next`],
						shapes.commands.nonCoreStatus,
						managedSessionName,
						"diff url",
					);

					await runCoreCommand(
						harness,
						["trace", "start"],
						shapes.commands.nonCoreStatus,
						managedSessionName,
						"trace start",
					);
					const tracePath = join(tempDir, "contract-trace.zip");
					await runCoreCommand(
						harness,
						["trace", "stop", tracePath],
						shapes.commands.nonCoreArtifact,
						managedSessionName,
						"trace stop",
					);
					assert.ok(
						readString(await readFileIfPresent(tracePath)).length > 0,
						"trace should be saved",
					);
					await runCoreCommand(
						harness,
						["profiler", "start"],
						shapes.commands.nonCoreStatus,
						managedSessionName,
						"profiler start",
					);
					const profilePath = join(tempDir, "contract.cpuprofile");
					await runCoreCommand(
						harness,
						["profiler", "stop", profilePath],
						shapes.commands.nonCoreArtifact,
						managedSessionName,
						"profiler stop",
					);
					assert.ok(
						readString(await readFileIfPresent(profilePath)).length > 0,
						"profile should be saved",
					);
					await runCoreCommand(
						harness,
						["open", contractUrl],
						shapes.commands.open,
						managedSessionName,
						"restore contract fixture after diff/debug flows",
					);
					await runCoreCommand(
						harness,
						["console"],
						shapes.commands.nonCoreStatus,
						managedSessionName,
						"console",
					);
					await runCoreCommand(
						harness,
						["errors"],
						shapes.commands.nonCoreStatus,
						managedSessionName,
						"errors",
					);
					await runCoreCommand(
						harness,
						["highlight", "#mark-ready"],
						shapes.commands.nonCoreStatus,
						managedSessionName,
						"highlight",
					);
					const priorStreamStatus = await runCoreCommand(
						harness,
						["stream", "status"],
						shapes.commands.streamStatus,
						managedSessionName,
						"stream status preflight",
					);
					if (readRecord(priorStreamStatus.data).enabled === true) {
						await runCoreCommand(
							harness,
							["stream", "disable"],
							shapes.commands.streamControl,
							managedSessionName,
							"stream disable preflight",
						);
					}
					await runCoreCommand(
						harness,
						["stream", "enable"],
						shapes.commands.streamControl,
						managedSessionName,
						"stream enable",
					);
					await runCoreCommand(
						harness,
						["stream", "status"],
						shapes.commands.streamStatus,
						managedSessionName,
						"stream status",
					);
					await runCoreCommand(
						harness,
						["stream", "disable"],
						shapes.commands.streamControl,
						managedSessionName,
						"stream disable",
					);

					const cookieFile = join(tempDir, "cookies.curl");
					await writeFile(cookieFile, "Cookie: piab_session=abc; piab_theme=dark\n", "utf8");
					const cookiesCurl = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["cookies", "set", "--curl", cookieFile, "--url", contractUrl],
					});
					const cookiesCurlDetails = assertSuccessfulResult(
						cookiesCurl,
						shapes.commands.cookiesCurl,
						"cookies set --curl",
					);
					assert.equal(readRecord(cookiesCurlDetails.data).set, true);

					const restoreMarker = "piab-real-upstream-restore";
					const seedRestoreState = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["eval", "--stdin"],
						stdin: `document.cookie = "piab_restore_cookie=${restoreMarker}; path=/"; localStorage.setItem("piab-restore-local", "${restoreMarker}"); sessionStorage.setItem("piab-restore-session", "${restoreMarker}"); true`,
					});
					assertSuccessfulResult(
						seedRestoreState,
						shapes.commands.eval,
						"seed managed restore state",
					);

					for (const params of [
						{
							args: ["batch"],
							stdin: JSON.stringify([
								["connect", "wss://remote.example/devtools/browser/test"],
								["snapshot", "-i"],
							]),
						},
						{ args: ["batch", "connect wss://remote.example/devtools/browser/test"] },
					]) {
						// Check each rejected batch leaves the same live managed session untouched.
						// oxlint-disable-next-line no-await-in-loop
						const blockedBatch = await executeRegisteredTool(harness.tool, harness.ctx, params);
						// Every fixed nested-attachment batch shape must fail before upstream spawn.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(blockedBatch.isError, true);
						// Every nested-attachment fixture must retain preflight failure classification.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							readRecord(blockedBatch.details).failureCategory,
							"validation-error",
							JSON.stringify(blockedBatch.details),
						);
						// Every nested-attachment fixture must explain its managed-session mismatch.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(
							readString(readRecord(blockedBatch.details).validationError),
							/does not match the requested managed-restore policy|active page became unverified/,
						);
						// Every nested-attachment fixture must prove rejection preceded native execution.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							readRecord(blockedBatch.details).exitCode,
							undefined,
							"nested batch attachment must fail before upstream spawn",
						);
					}
					for (const subcommand of ["start", "restart"]) {
						// Each preflight must fail before close can mutate the shared managed browser.
						// oxlint-disable-next-line no-await-in-loop
						const blockedRecordingAfterClose = await executeRegisteredTool(
							harness.tool,
							harness.ctx,
							{
								args: ["batch"],
								stdin: JSON.stringify([
									["close"],
									["record", subcommand, join(tempDir, `after-close-${subcommand}.webm`)],
								]),
							},
						);
						// Both fixed start/restart-after-close fixtures must fail preflight.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(blockedRecordingAfterClose.isError, true);
						// Both recording-after-close fixtures must retain validation failure classification.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							readRecord(blockedRecordingAfterClose.details).failureCategory,
							"validation-error",
						);
						// Both recording-after-close fixtures must name their own forbidden subcommand.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(
							resultText(blockedRecordingAfterClose),
							new RegExp(`record ${subcommand} cannot follow close`),
						);
						// Both recording-after-close fixtures must prove no native command was dispatched.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							readRecord(blockedRecordingAfterClose.details).exitCode,
							undefined,
							"recording after close must fail before upstream spawn",
						);
					}
					const lateConfigPath = join(tempDir, "agent-browser.json");
					await writeFile(
						lateConfigPath,
						JSON.stringify({ restore: "replacement-close-key" }),
						"utf8",
					);
					const closingPid = Number(
						await readFile(join(socketDir, `${readString(managedSessionName)}.pid`), "utf8"),
					);
					assert.ok(Number.isSafeInteger(closingPid));
					assert.ok(closingPid > 0);
					const firstClose = await (async () => {
						try {
							return await withPatchedEnv(
								{ AGENT_BROWSER_NAMESPACE: "redirected" },
								async () =>
									await executeRegisteredTool(harness.tool, harness.ctx, {
										args: [
											"--session",
											readString(managedSessionName),
											"--config",
											lateConfigPath,
											"--restore",
											"replacement-close-key",
											"close",
										],
									}),
							);
						} finally {
							await rm(lateConfigPath, { force: true });
						}
					})();
					assert.equal(
						firstClose.isError,
						false,
						`first managed close should persist restore state despite late config: ${resultText(firstClose)}`,
					);
					assert.equal(
						await waitForTestPidExit(closingPid, 10_000),
						true,
						"closed native daemon must exit",
					);
					const closedInfo = await execFileAsync(
						"agent-browser",
						[
							"--json",
							"--namespace",
							"",
							"--session",
							readString(managedSessionName),
							"session",
							"info",
						],
						{
							cwd: tempDir,
							env: {
								...process.env,
								AGENT_BROWSER_NAMESPACE: "redirected",
								AGENT_BROWSER_SOCKET_DIR:
									process.env.PI_AGENT_BROWSER_SOCKET_DIR ??
									getAgentBrowserSocketDir() ??
									socketDir,
								HOME: tempDir,
							},
						},
					);
					assert.equal(
						readRecord(readRecord(JSON.parse(closedInfo.stdout)).data).active,
						false,
						"owned close must override a redirecting namespace environment",
					);

					const restoreScope = getManagedSessionRestoreScope(readString(managedSessionName));
					const managedRestoreKey = createManagedSessionRestoreKey(tempDir, restoreScope);
					const foreignRestoreKey = createManagedSessionRestoreKey(
						tempDir,
						`${restoreScope}-foreign-chat`,
					);
					assert.notEqual(
						foreignRestoreKey,
						managedRestoreKey,
						"concurrent Pi chats must not share an upstream newest-file-wins restore pool",
					);
					const restoreSessionsDirectory = join(tempDir, ".agent-browser", "sessions");
					await writeFile(
						join(restoreSessionsDirectory, `${foreignRestoreKey}-newer-empty.json`),
						JSON.stringify({ cookies: [], origins: [] }),
						"utf8",
					);

					const sameExtensionRestoredOpen = await (async () => {
						try {
							await writeFile(
								lateConfigPath,
								JSON.stringify({ restore: foreignRestoreKey }),
								"utf8",
							);
							return await executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["open", contractUrl],
							});
						} finally {
							await rm(lateConfigPath, { force: true });
						}
					})();
					assertSuccessfulResult(
						sameExtensionRestoredOpen,
						shapes.commands.open,
						"reopen restored managed session after close in same extension",
					);
					const sameExtensionRestoreState = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["eval", "--stdin"],
						stdin: `JSON.stringify({ cookiePresent: document.cookie.includes("piab_restore_cookie=${restoreMarker}"), local: localStorage.getItem("piab-restore-local"), session: sessionStorage.getItem("piab-restore-session") })`,
					});
					const sameExtensionRestoreDetails = assertSuccessfulResult(
						sameExtensionRestoreState,
						shapes.commands.eval,
						"read same-extension restored managed state",
					);
					const sameExtensionRestoredValue = readRecord(
						JSON.parse(readString(readRecord(sameExtensionRestoreDetails.data).result)),
					);
					assert.equal(sameExtensionRestoredValue.cookiePresent, true);
					assert.equal(sameExtensionRestoredValue.local, restoreMarker);
					assert.equal(sameExtensionRestoredValue.session, restoreMarker);
					const sameExtensionRestoredClose = await executeRegisteredTool(
						harness.tool,
						harness.ctx,
						{ args: ["close"] },
					);
					assert.equal(
						sameExtensionRestoredClose.isError,
						false,
						`same-extension restored managed close should succeed: ${resultText(sameExtensionRestoredClose)}`,
					);

					const restoredHarness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						restoredHarness.handlers,
						"session_start",
						{ reason: "resume" },
						restoredHarness.ctx,
					);
					let restoredValueText: string | undefined;
					try {
						const restoredOpen = await executeRegisteredTool(
							restoredHarness.tool,
							restoredHarness.ctx,
							{ args: ["open", contractUrl], sessionMode: "fresh" },
						);
						assertSuccessfulResult(
							restoredOpen,
							shapes.commands.open,
							"open restored managed session",
						);
						const readRestoreState = await executeRegisteredTool(
							restoredHarness.tool,
							restoredHarness.ctx,
							{
								args: ["eval", "--stdin"],
								stdin: `JSON.stringify({ cookiePresent: document.cookie.includes("piab_restore_cookie=${restoreMarker}"), local: localStorage.getItem("piab-restore-local"), session: sessionStorage.getItem("piab-restore-session") })`,
							},
						);
						const restoredDetails = assertSuccessfulResult(
							readRestoreState,
							shapes.commands.eval,
							"read restored managed state",
						);
						restoredValueText = readString(readRecord(restoredDetails.data).result);
					} finally {
						const restoredClose = await executeRegisteredTool(
							restoredHarness.tool,
							restoredHarness.ctx,
							{ args: ["close"] },
						);
						assert.equal(
							restoredClose.isError,
							false,
							`restored managed close should succeed: ${resultText(restoredClose)}`,
						);
					}
					const restoredValue = readRecord(JSON.parse(readString(restoredValueText)));
					assert.equal(restoredValue.cookiePresent, true);
					assert.equal(restoredValue.local, restoreMarker);
					assert.equal(restoredValue.session, restoreMarker);

					const isolatedHarness = createExtensionHarness({
						cwd: tempDir,
						sessionId: "87654321876543218765432187654321",
					});
					await runExtensionEvent(
						isolatedHarness.handlers,
						"session_start",
						{ reason: "new" },
						isolatedHarness.ctx,
					);
					let isolatedValueText: string | undefined;
					try {
						const isolatedOpen = await executeRegisteredTool(
							isolatedHarness.tool,
							isolatedHarness.ctx,
							{ args: ["open", contractUrl], sessionMode: "fresh" },
						);
						assertSuccessfulResult(
							isolatedOpen,
							shapes.commands.open,
							"open distinct-transcript managed session",
						);
						const isolatedState = await executeRegisteredTool(
							isolatedHarness.tool,
							isolatedHarness.ctx,
							{
								args: ["eval", "--stdin"],
								stdin: `JSON.stringify({ cookiePresent: document.cookie.includes("piab_restore_cookie=${restoreMarker}"), local: localStorage.getItem("piab-restore-local"), session: sessionStorage.getItem("piab-restore-session") })`,
							},
						);
						const isolatedDetails = assertSuccessfulResult(
							isolatedState,
							shapes.commands.eval,
							"read distinct-transcript managed state",
						);
						isolatedValueText = readString(readRecord(isolatedDetails.data).result);
					} finally {
						const isolatedClose = await executeRegisteredTool(
							isolatedHarness.tool,
							isolatedHarness.ctx,
							{ args: ["close"] },
						);
						assert.equal(
							isolatedClose.isError,
							false,
							`distinct-transcript managed close should succeed: ${resultText(isolatedClose)}`,
						);
					}
					const isolatedValue = readRecord(JSON.parse(readString(isolatedValueText)));
					assert.equal(isolatedValue.cookiePresent, false);
					assert.equal(isolatedValue.local, null);
					assert.equal(isolatedValue.session, null);

					const reactWithoutReactApp = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "--enable", "react-devtools", contractUrl],
						sessionMode: "fresh",
					});
					const possibleReactSession = readRecord(reactWithoutReactApp.details).sessionName;
					const reactSessionName =
						typeof possibleReactSession === "string" ? possibleReactSession : undefined;
					managedSessionName = reactSessionName ?? managedSessionName;
					const reactTree = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["react", "tree"],
					});
					assert.equal(
						reactTree.isError,
						true,
						`react tree should report missing React renderer on the non-React fixture: ${resultText(reactTree)}`,
					);
					assertHasKeys(
						reactTree.details,
						shapes.commands.reactMissingRenderer.detailKeys,
						"react tree missing-renderer details",
					);
					assert.equal(readRecord(reactTree.details).sessionName, reactSessionName);
					assert.match(
						readString(readRecord(reactTree.details).error ?? resultText(reactTree)),
						/No React renderer|React DevTools hook/,
					);

					const downloadPath = join(tempDir, "wait-download-report.txt");
					const downloadPage = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", `${fixtureBaseUrl}/download`],
					});
					assertSuccessfulResult(downloadPage, shapes.commands.open, "open download fixture");
					const clickedExport = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["click", "#delayed-anchor-download"],
					});
					assert.equal(
						clickedExport.isError,
						false,
						`click should start async download: ${resultText(clickedExport)}`,
					);
					const waitedDownload = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["wait", "--download", downloadPath],
					});
					assert.equal(
						waitedDownload.isError,
						true,
						`wait --download should fail closed when the reported file is missing: ${resultText(waitedDownload)}`,
					);
					assertHasKeys(
						waitedDownload.details,
						shapes.commands.waitDownload.detailKeys,
						"wait --download details",
					);
					const waitDownloadDetails = readRecord(waitedDownload.details);
					assert.equal(waitDownloadDetails.resultCategory, "failure");
					assert.equal(waitDownloadDetails.failureCategory, "artifact-missing");
					assert.equal(waitDownloadDetails.sessionName, managedSessionName);
					assert.equal(waitDownloadDetails.usedImplicitSession, true);
					assert.equal(waitDownloadDetails.savedFilePath, downloadPath);
					assert.equal(readRecord(waitDownloadDetails.savedFile).path, downloadPath);
					assert.match(resultText(waitedDownload), /Artifact verification failed/);
					assert.match(resultText(waitedDownload), /Download event reported; file not verified/);

					// Upstream tracking: https://github.com/vercel-labs/agent-browser/issues/1300.
					// Current upstream reports the requested saveAs path but leaves the file in the
					// browser's default download directory. The wrapper must fail closed so release
					// docs do not overstate savedFilePath as a verified on-disk artifact.
					const artifacts = readArray(waitDownloadDetails.artifacts).map(readRecord);
					assert.equal(artifacts[0].path, downloadPath);
					assert.equal(artifacts[0].exists, false);
					assert.equal(
						await readFileIfPresent(downloadPath),
						undefined,
						"current upstream reports the requested wait --download path but does not persist the file there; update this contract if upstream saveAs persistence becomes reliable",
					);
				},
			);
		} finally {
			await closeManagedSessionIfPresent({
				cwd: tempDir,
				sessionName: managedSessionName,
				socketDir,
			});
			await fixtureServer?.close();
			await rm(tempDir, { force: true, recursive: true });
			await rm(socketDir, { force: true, recursive: true });
		}
		// These controls require first-launch flags and automatic restore, not executable-env reconfiguration.
		await withPatchedEnv({ AGENT_BROWSER_EXECUTABLE_PATH: undefined }, async () => {
			await assertRealUpstreamLocalDaemonPassesThrough();
			await assertRealUpstreamRestoredDaemonReuseFailsClosed();
			await assertRealUpstreamRestoreStorageSymlinkFailsClosed();
			await assertRealUpstreamNestedRestoreStorageSymlinkFailsClosed();
			await assertRealUpstreamRelativeHomeFailsClosed();
		});
	},
);

test(
	"real upstream agent-browser plugin list stays sessionless",
	{
		skip: REAL_UPSTREAM_ENABLED ? false : REAL_UPSTREAM_SKIP_REASON,
		timeout: 60_000,
	},
	async () => {
		await assertInstalledAgentBrowserVersion();
		const shapes = await readOutputShapesFixture();
		assert.equal(
			shapes.targetVersion,
			CAPABILITY_BASELINE.targetVersion,
			"output-shape fixture must track the canonical target version",
		);

		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-real-upstream-plugins-"));
		try {
			await withPatchedEnv({ HOME: tempDir, AGENT_BROWSER_PLUGINS: "[]" }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				const pluginList = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["plugin", "list"],
				});
				const pluginListDetails = assertSuccessfulResult(
					pluginList,
					shapes.commands.pluginList,
					"plugin list empty",
				);
				assert.equal(pluginListDetails.sessionName, undefined);
				assert.equal(pluginListDetails.usedImplicitSession, undefined);
				assert.deepEqual(pluginListDetails.effectiveArgs, ["--json", "plugin", "list"]);
				assert.deepEqual(readRecord(pluginListDetails.data).plugins, []);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);
