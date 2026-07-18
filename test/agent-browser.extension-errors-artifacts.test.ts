/**
 * Purpose: Verify extension entrypoint validation-error and diagnostic contracts.
 * Responsibilities: Assert malformed args/envelopes, timeout progress, managed-session, selector visibility, overlay, prompt guards, and tab-drift diagnostics.
 * Scope: Integration-style Node test-runner coverage split out of the broad extension-validation suite.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-errors-artifacts.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileAgentBrowserJob } from "../extensions/agent-browser/lib/input-modes/job.js";
import {
	collectTimeoutPartialProgress,
	formatTimeoutPartialProgressText,
} from "../extensions/agent-browser/lib/orchestration/browser-run/diagnostics.js";
import {
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test("agentBrowserExtension rejects dangling value-taking flags before spawning agent-browser", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { args } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			assert.match((result.content[0] as { text: string }).text, /requires a value immediately after it/i);
			assert.equal(
				(result.details?.invalidValueFlag as { flag?: string; reason?: string } | undefined)?.flag,
				"--session",
			);
			assert.equal(
				(result.details?.invalidValueFlag as { flag?: string; reason?: string } | undefined)?.reason,
				"missing-value",
			);
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(result.details?.failureCategory, "validation-error");
			assert.deepEqual(await readInvocationLog(logPath), []);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

const MISSING_SUCCESS_PARSE_ERROR = "agent-browser returned an invalid JSON envelope: missing boolean success field.";

test("agentBrowserExtension rejects malformed JSON envelopes that omit success", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ error: "boom" }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.com"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			assert.equal((result.content[0] as { text: string }).text, MISSING_SUCCESS_PARSE_ERROR);
			assert.equal(result.details?.parseError, MISSING_SUCCESS_PARSE_ERROR);
			assert.equal(result.details?.summary, MISSING_SUCCESS_PARSE_ERROR);
			assert.doesNotMatch(String(result.details?.summary ?? ""), /^open completed$/i);
			assert.equal(result.details?.error, undefined);
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(result.details?.failureCategory, "parse-failure");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension forwards long waits and extends the subprocess watchdog from explicit wait timeouts", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-wait-timeout-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2), stdin, defaultTimeout: process.env.AGENT_BROWSER_DEFAULT_TIMEOUT }) + "\\n");
let delay = 100;
try {
  const parsed = JSON.parse(stdin);
  const waitCount = Array.isArray(parsed) ? parsed.filter((step) => Array.isArray(step) && step[0] === "wait").length : 0;
  if (waitCount > 1) delay = 6500;
} catch {}
setTimeout(() => process.stdout.write(JSON.stringify({ success: true, data: { ok: true } })), delay);`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "50" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const directWait = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["wait", "31000"],
			});
			const downloadWait = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["wait", "--download", "/tmp/export.csv", "--timeout", "30000"],
			});
			const batchWaitStdin = JSON.stringify([["wait", "--text", "42", "--timeout", "1000"], ["wait", "1000"]]);
			const batchWait = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: batchWaitStdin,
			});

			for (const result of [directWait, downloadWait, batchWait]) {
				assert.equal(result.isError, false);
				assert.equal(result.details?.resultCategory, "success");
			}
			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations.map((entry) => entry.args.slice(-4)), [
				["--session", invocations[0].args[2], "wait", "31000"],
				["--download", "/tmp/export.csv", "--timeout", "30000"],
				["--json", "--session", invocations[2].args[2], "batch"],
			]);
			assert.equal(invocations[2].stdin, batchWaitStdin);
			assert.deepEqual(invocations.map((entry) => entry.defaultTimeout), ["25000", "25000", "25000"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension warns when eval stdin returns an empty object from a function-shaped snippet", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-eval-stdin-hint-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const stdin = fs.readFileSync(0, "utf8");
const trimmed = stdin.trim();
if (trimmed === "(() => [])()") {
  process.stdout.write(JSON.stringify({ success: true, data: { result: [], origin: "https://example.com/" } }));
} else if (trimmed === "(() => [1])()") {
  process.stdout.write(JSON.stringify({ success: true, data: { result: [1], origin: "https://example.com/" } }));
} else if (trimmed.startsWith("() =>")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: {}, origin: "https://example.com/" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Example Domain" }, origin: "https://example.com/" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const functionResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "() => ({ title: document.title })",
			});
			assert.equal(functionResult.isError, false);
			assert.match((functionResult.content[0] as { text: string }).text, /Eval stdin hint:/);
			assert.match((functionResult.content[0] as { text: string }).text, /\(\{ title: document\.title \}\)/);
			assert.deepEqual(functionResult.details?.evalStdinHint, {
				reason: "eval --stdin received a function-shaped snippet and the upstream JSON result was an empty object, which often means the function itself was returned or serialized instead of invoked.",
				suggestion: "Pass a plain expression such as `({ title: document.title })`, or invoke the function explicitly, for example `(() => ({ title: document.title }))()`.",
			});

			const jsonFunctionResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--json", "eval", "--stdin"],
				stdin: "() => ({ title: document.title })",
			});
			assert.equal(jsonFunctionResult.isError, false);
			const jsonFunctionText = (jsonFunctionResult.content[0] as { text: string }).text;
			assert.doesNotMatch(jsonFunctionText, /Eval stdin hint:/);
			assert.deepEqual(JSON.parse(jsonFunctionText), {
				data: { origin: "https://example.com/", result: {} },
				success: true,
			});
			assert.deepEqual(jsonFunctionResult.details?.evalStdinHint, functionResult.details?.evalStdinHint);

			const emptyArrayIifeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "(() => [])()",
			});
			assert.equal(emptyArrayIifeResult.isError, false);
			assert.doesNotMatch((emptyArrayIifeResult.content[0] as { text: string }).text, /Eval stdin hint:/);
			assert.equal(emptyArrayIifeResult.details?.evalStdinHint, undefined);

			const nonEmptyArrayIifeResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "(() => [1])()",
			});
			assert.equal(nonEmptyArrayIifeResult.isError, false);
			assert.doesNotMatch((nonEmptyArrayIifeResult.content[0] as { text: string }).text, /Eval stdin hint:/);
			assert.equal(nonEmptyArrayIifeResult.details?.evalStdinHint, undefined);

			const expressionResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "({ title: document.title })",
			});
			assert.equal(expressionResult.isError, false);
			assert.doesNotMatch((expressionResult.content[0] as { text: string }).text, /Eval stdin hint:/);
			assert.equal(expressionResult.details?.evalStdinHint, undefined);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension normalizes eval --stdin scripts misplaced in args", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-eval-stdin-args-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { result: stdin.trim() === "document.title" ? "Fixture Title" : null, origin: "file:///tmp/fixture.html" } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin", "document.title"],
			});

			assert.equal(result.isError, false);
			assert.equal((result.content[0] as { text: string }).text.split("\n")[0], "Fixture Title");
			const [invocation] = await readInvocationLog(logPath);
			assert.deepEqual(invocation?.args.slice(-2), ["eval", "--stdin"]);
			assert.equal(invocation?.stdin, "document.title");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension warns when eval --stdin returns null on file pages", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-eval-file-null-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "fixture", url: args.at(-1) || "about:blank" } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "file:///tmp/fixture.html" } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: null } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			const openResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "file:///tmp/fixture.html"] });
			assert.equal(openResult.isError, false);
			assert.equal((openResult.details?.sessionTabTarget as { url?: string } | undefined)?.url, "file:///tmp/fixture.html");

			const nullEvalResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "document.getElementById('missing')?.textContent",
			});
			assert.equal(nullEvalResult.isError, false);
			assert.match((nullEvalResult.content[0] as { text: string }).text, /Eval result warning:/);
			assert.match((nullEvalResult.content[0] as { text: string }).text, /file:\/\/ page/);
			assert.deepEqual(nullEvalResult.details?.evalResultWarning, {
				reason: "eval --stdin returned null on a file:// page; upstream may not expose full DOM semantics for local fixtures.",
				suggestion: "Treat this as inconclusive verification. Use snapshot -i, get text on current @refs, screenshot evidence, or a reachable http(s) fixture before concluding DOM state.",
			});

			const literalNullResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "null",
			});
			assert.equal(literalNullResult.isError, false);
			assert.equal(literalNullResult.details?.evalResultWarning, undefined);
			assert.doesNotMatch((literalNullResult.content[0] as { text: string }).text, /Eval result warning:/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports managed-session outcomes after failed fresh launches", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-managed-session-outcome-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("https://fail.test")) {
  console.error("simulated launch failure");
  process.exit(2);
}
process.stdout.write(JSON.stringify({ success: true, data: { title: "ok", url: args.at(-1) || "about:blank" } }));`,
	);

	try {
		const missingBinaryDir = await mkdtemp(join(tempDir, "missing-agent-browser-"));
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const firstResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "previous", "open", "https://previous.test"] });
			assert.equal(firstResult.isError, false);
			const previousSessionName = firstResult.details?.sessionName as string;
			assert.ok(previousSessionName);

			const failedFreshResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "next", "open", "https://fail.test"], sessionMode: "fresh" });
			assert.equal(failedFreshResult.isError, true);
			const preservedOutcome = failedFreshResult.details?.managedSessionOutcome as { activeAfter?: boolean; activeBefore?: boolean; attemptedSessionName?: string; currentSessionName?: string; currentSessionNamespace?: string; previousSessionName?: string; sessionMode?: string; status?: string; succeeded?: boolean; summary?: string } | undefined;
			assert.equal(preservedOutcome?.status, "preserved");
			assert.equal(preservedOutcome?.activeBefore, true);
			assert.equal(preservedOutcome?.activeAfter, true);
			assert.equal(preservedOutcome?.currentSessionName, previousSessionName);
			assert.equal(preservedOutcome?.currentSessionNamespace, "previous");
			assert.equal(preservedOutcome?.previousSessionName, previousSessionName);
			assert.equal(preservedOutcome?.sessionMode, "fresh");
			assert.match(preservedOutcome?.attemptedSessionName ?? "", /-fresh-/);
			assert.equal(preservedOutcome?.succeeded, false);
			assert.match((failedFreshResult.content[0] as { text: string }).text, /Managed session outcome: Fresh launch failed; your previous browser session is still active\./);
			assert.match((failedFreshResult.content[0] as { text: string }).text, /Recovery:/);
			assert.match((failedFreshResult.content[0] as { text: string }).text, /details\.managedSessionOutcome/);
			const preservedNextActions = failedFreshResult.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined;
			assert.ok(preservedNextActions?.some((action) => action.id === "run-agent-browser-doctor"));
			assert.ok(preservedNextActions?.some((action) => action.id === "verify-current-managed-session" && action.params?.args?.join(" ") === `--namespace previous --session ${previousSessionName} get url`));

			await withPatchedEnv({ PATH: missingBinaryDir }, async () => {
				const missingBinaryResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["--namespace", "next", "open", "https://missing-binary.test"], sessionMode: "fresh" });
				assert.equal(missingBinaryResult.isError, true);
				assert.equal(missingBinaryResult.details?.failureCategory, "missing-binary");
				const missingBinaryOutcome = missingBinaryResult.details?.managedSessionOutcome as { activeAfter?: boolean; activeBefore?: boolean; currentSessionName?: string; currentSessionNamespace?: string; previousSessionName?: string; sessionMode?: string; status?: string } | undefined;
				assert.equal(missingBinaryOutcome?.status, "preserved");
				assert.equal(missingBinaryOutcome?.activeBefore, true);
				assert.equal(missingBinaryOutcome?.activeAfter, true);
				assert.equal(missingBinaryOutcome?.currentSessionName, previousSessionName);
				assert.equal(missingBinaryOutcome?.currentSessionNamespace, "previous");
				assert.equal(missingBinaryOutcome?.previousSessionName, previousSessionName);
				assert.equal(missingBinaryOutcome?.sessionMode, "fresh");
				assert.match((missingBinaryResult.content[0] as { text: string }).text, /Managed session outcome: Fresh launch failed; your previous browser session is still active\./);
				const missingBinaryNextActions = missingBinaryResult.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined;
				assert.ok(missingBinaryNextActions?.some((action) => action.id === "run-agent-browser-doctor"));
				assert.ok(missingBinaryNextActions?.some((action) => action.id === "verify-current-managed-session" && action.params?.args?.join(" ") === `--namespace previous --session ${previousSessionName} get url`));

				const abandonedMissingBinaryHarness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(abandonedMissingBinaryHarness.handlers, "session_start", { reason: "new" }, abandonedMissingBinaryHarness.ctx);
				const abandonedMissingBinary = await executeRegisteredTool(abandonedMissingBinaryHarness.tool, abandonedMissingBinaryHarness.ctx, { args: ["--namespace", "next", "open", "https://missing-binary.test"], sessionMode: "fresh" });
				assert.equal(abandonedMissingBinary.isError, true);
				const abandonedMissingBinaryNextActions = abandonedMissingBinary.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined;
				assert.ok(abandonedMissingBinaryNextActions?.some((action) => action.id === "retry-fresh-managed-session" && action.params?.args?.join(" ") === "--namespace next open about:blank"));
			});

			const followupResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "url"] });
			assert.equal(followupResult.isError, false);
			assert.equal(followupResult.details?.sessionName, previousSessionName);

			const abandonedHarness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(abandonedHarness.handlers, "session_start", { reason: "new" }, abandonedHarness.ctx);
			const abandonedResult = await executeRegisteredTool(abandonedHarness.tool, abandonedHarness.ctx, { args: ["open", "https://fail.test"], sessionMode: "fresh" });
			assert.equal(abandonedResult.isError, true);
			const abandonedOutcome = abandonedResult.details?.managedSessionOutcome as { activeAfter?: boolean; activeBefore?: boolean; status?: string; summary?: string } | undefined;
			assert.equal(abandonedOutcome?.status, "abandoned");
			assert.equal(abandonedOutcome?.activeBefore, false);
			assert.equal(abandonedOutcome?.activeAfter, false);
			assert.match((abandonedResult.content[0] as { text: string }).text, /no managed browser session is current/);
			const abandonedNextActions = abandonedResult.details?.nextActions as Array<{ id?: string }> | undefined;
			assert.ok(abandonedNextActions?.some((action) => action.id === "retry-fresh-managed-session"));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension writes eval and get output data to requested files", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-output-file-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith("-") && arg !== "piab-test");
if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Example", rows: [1, 2, 3] } } }));
} else if (args.includes("get")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "visible terminal text" } }));
} else if (args.includes("#fail")) {
  process.stdout.write(JSON.stringify({ success: false, error: "button failed" }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { command } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const evalResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "({ title: document.title })",
				outputPath: "logs/eval-state.json",
			});
			assert.equal(evalResult.isError, false);
			assert.deepEqual(JSON.parse(await readFile(join(tempDir, "logs/eval-state.json"), "utf8")), { result: { title: "Example", rows: [1, 2, 3] } });
			assert.match(evalResult.content[0]?.text ?? "", /Output file: logs\/eval-state\.json/);
			assert.deepEqual((evalResult.details?.outputFile as { path?: string; source?: string; status?: string } | undefined), {
				path: "logs/eval-state.json",
				source: "details.data",
				status: "saved",
				absolutePath: join(tempDir, "logs/eval-state.json"),
				bytes: 92,
			});

			const getResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["get", "text", "@e1"],
				outputPath: "@logs/terminal-state.final.txt",
			});
			assert.equal(getResult.isError, false);
			assert.equal(await readFile(join(tempDir, "logs/terminal-state.final.txt"), "utf8"), JSON.stringify({ result: "visible terminal text" }, null, 2) + "\n");
			assert.match(getResult.content[0]?.text ?? "", /Output file: logs\/terminal-state\.final\.txt/);

			const jsonResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["stream", "status", "--json"],
				outputPath: "logs/stream-status.json",
			});
			assert.equal(jsonResult.isError, false);
			const jsonText = jsonResult.content[0]?.type === "text" ? jsonResult.content[0].text ?? "" : "";
			assert.doesNotMatch(jsonText, /Output file:/);
			assert.doesNotThrow(() => JSON.parse(jsonText));
			const savedJsonText = await readFile(join(tempDir, "logs/stream-status.json"), "utf8");
			assert.doesNotThrow(() => JSON.parse(savedJsonText));

			await writeFile(join(tempDir, "blocked-output-parent"), "not a directory");
			const writeFailureResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["eval", "--stdin"],
				stdin: "() => ({ ok: true })",
				outputPath: "blocked-output-parent/result.json",
			});
			assert.equal(writeFailureResult.isError, true);
			assert.equal(writeFailureResult.details?.resultCategory, "failure");
			assert.equal(writeFailureResult.details?.failureCategory, "upstream-error");
			assert.equal(writeFailureResult.details?.successCategory, undefined);
			assert.equal((writeFailureResult.details?.outputFile as { status?: string } | undefined)?.status, "failed");

			const failedResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["click", "#fail"],
				outputPath: "logs/failed-action.txt",
			});
			assert.equal(failedResult.isError, true);
			assert.equal(failedResult.details?.outputFile, undefined);
			await assert.rejects(readFile(join(tempDir, "logs/failed-action.txt"), "utf8"));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports partial progress and artifacts after job timeout", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-job-timeout-progress-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "https://example.test/secret-token/results?token=url-secret" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "Results page export secret-token Authorization: Bearer title-secret" } }));
} else if (args.includes("batch")) {
  const stdin = fs.readFileSync(0, "utf8");
  const steps = JSON.parse(stdin);
  const screenshotStep = steps.find((step) => step[0] === "screenshot");
  const screenshot = screenshotStep?.filter((token) => !String(token).startsWith('-')).at(-1);
  if (screenshot && screenshot !== 'screenshot') {
    fs.mkdirSync(path.dirname(path.resolve(screenshot)), { recursive: true });
    fs.writeFileSync(path.resolve(screenshot), "fake image");
  }
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		// The timed-out fake upstream normally writes this before hanging, but pre-create it
		// so this diagnostic test is about wrapper timeout progress instead of Node process
		// startup timing under full-suite load.
		await mkdir(join(tempDir, "dogfood/secret-token"), { recursive: true });
		await writeFile(join(tempDir, "dogfood/secret-token/filled.png"), "fake image");
		await mkdir(join(tempDir, "dogfood"), { recursive: true });
		await writeFile(join(tempDir, "dogfood/option-full-page.png"), "fake image");
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "2000" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: {
					steps: [
						{ action: "open", url: "https://example.test" },
						{ action: "fill", selector: "#search", text: "export" },
						{ action: "screenshot", path: "dogfood/secret-token/filled.png" },
						{ action: "waitForDownload", path: "dogfood/export.csv" },
						{ action: "wait", milliseconds: 500 },
					],
				},
			});

			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "timeout");
			assert.equal(result.details?.timedOut, true);
			const timeoutProgress = result.details?.timeoutPartialProgress as { artifacts?: Array<{ exists?: boolean; path?: string; sizeBytes?: number; state?: string; stepIndex?: number }>; currentPage?: { source?: string; title?: string; url?: string }; openedButPostOpenTimedOut?: boolean; retryStep?: { args?: string[]; index?: number; status?: string }; steps?: Array<{ args?: string[]; index?: number; status?: string }> } | undefined;
			assert.ok(
				timeoutProgress?.currentPage?.url === "https://example.test/secret-token/results?token=%5BREDACTED%5D" ||
					timeoutProgress?.currentPage?.url === "https://example.test/",
				`unexpected timeout current page URL: ${timeoutProgress?.currentPage?.url}`,
			);
			if (timeoutProgress?.currentPage?.title) {
				assert.equal(timeoutProgress.currentPage.title, "Results page export secret-token Authorization: Bearer [REDACTED]");
			}
			assert.deepEqual(timeoutProgress?.artifacts?.map((artifact) => ({ exists: artifact.exists, path: artifact.path, state: artifact.state, stepIndex: artifact.stepIndex })), [
				{ exists: true, path: "dogfood/secret-token/filled.png", state: "verified", stepIndex: 3 },
				{ exists: false, path: "dogfood/export.csv", state: "missing", stepIndex: 4 },
			]);
			assert.deepEqual(timeoutProgress?.steps?.map((step) => [step.args?.[0], step.status]), [["open", "completed"], ["fill", "completed"], ["screenshot", "completed"], ["wait", "failed"], ["wait", "pending"]]);
			assert.equal(timeoutProgress?.openedButPostOpenTimedOut, true);
			assert.deepEqual(timeoutProgress?.retryStep?.args, ["wait", "--download", "dogfood/export.csv"]);
			const text = (result.content[0] as { text: string }).text;
			assert.match(text, /Timeout partial progress:/);
			if (timeoutProgress?.currentPage?.title) {
				assert.match(text, /Current page: \[REDACTED\] — https:\/\/example.test\/\[REDACTED\]\/results\?token=%5BREDACTED%5D/);
			} else {
				assert.match(text, /Current page: https:\/\/example.test\//);
			}
			assert.match(text, /Artifact from step 3: dogfood\/\[REDACTED\]\/filled\.png \(exists, 10 bytes\)/);
			assert.doesNotMatch(text, /url-secret|title-secret|secret-token/);
			assert.match(text, /Step 2 \[completed\]: fill #search export/);
			assert.match(text, /Step 4 \[failed\]: wait --download dogfood\/export\.csv/);
			assert.match(text, /Retry failed step: \{"args":\["wait","--download","dogfood\/export\.csv"\]\}/);
			assert.match(text, /Artifact from step 4: dogfood\/export\.csv \(missing\)/);
			assert.deepEqual((result.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined)?.find((action) => action.id === "retry-timeout-step")?.params?.args?.slice(-3), ["wait", "--download", "dogfood/export.csv"]);

			const batchResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["screenshot", "--full-page", "dogfood/option-full-page.png"], ["wait", "--download", "dogfood/download.csv", "--timeout", "1000"]]),
			});
			assert.equal(batchResult.isError, true);
			const batchProgress = batchResult.details?.timeoutPartialProgress as { artifacts?: Array<{ exists?: boolean; path?: string; stepIndex?: number }>; retryStep?: { args?: string[]; index?: number; status?: string }; steps?: Array<{ status?: string }> } | undefined;
			assert.deepEqual(batchProgress?.artifacts?.map((artifact) => ({ exists: artifact.exists, path: artifact.path, stepIndex: artifact.stepIndex })), [
				{ exists: true, path: "dogfood/option-full-page.png", stepIndex: 1 },
				{ exists: false, path: "dogfood/download.csv", stepIndex: 2 },
			]);

			const waitNoPathResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["wait", "--download", "--timeout", "1000"]]),
			});
			assert.equal(waitNoPathResult.isError, true);
			const waitNoPathProgress = waitNoPathResult.details?.timeoutPartialProgress as { artifacts?: Array<{ path?: string }> } | undefined;
			assert.deepEqual(waitNoPathProgress?.artifacts, []);

			const openBeforeMutatingTimeout = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://example.test"], timeoutMs: 10_000 });
			assert.equal(openBeforeMutatingTimeout.isError, false);
			const mutatingTimeoutResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "fill", selector: "#search", text: "export" }, { action: "wait", milliseconds: 500 }] },
			});
			assert.equal(mutatingTimeoutResult.isError, true);
			const mutatingProgress = mutatingTimeoutResult.details?.timeoutPartialProgress as { retryStep?: { args?: string[]; retry?: { args?: string[] }; status?: string } } | undefined;
			assert.deepEqual(mutatingProgress?.retryStep?.args, ["fill", "#search", "export"]);
			assert.equal(mutatingProgress?.retryStep?.retry, undefined);
			const mutatingNextActions = (mutatingTimeoutResult.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined) ?? [];
			assert.equal(mutatingNextActions.some((action) => action.id === "retry-timeout-step"), false);
			assert.deepEqual(mutatingNextActions.find((action) => action.id === "inspect-current-page-after-timeout")?.params?.args?.slice(-2), ["snapshot", "-i"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension retries fresh timed-out navigation in a new session when no live URL is recovered", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-fresh-timeout-retry-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("batch")) {
  setInterval(() => {}, 60_000);
} else {
  process.stdout.write(JSON.stringify({ success: false, error: "no live page" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS: "200" }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "open", url: "https://example.test/fresh-timeout" }, { action: "wait", milliseconds: 100 }] },
				sessionMode: "fresh",
			});

			assert.equal(result.isError, true);
			const progress = result.details?.timeoutPartialProgress as { currentPage?: { source?: string; url?: string }; liveUrlRecovered?: boolean; retryStep?: { args?: string[] } } | undefined;
			assert.equal(progress?.currentPage?.source, "planned");
			assert.equal(progress?.liveUrlRecovered, false);
			assert.deepEqual(progress?.retryStep?.args, ["open", "https://example.test/fresh-timeout"]);
			const retryAction = (result.details?.nextActions as Array<{ id?: string; params?: { args?: string[]; sessionMode?: string } }> | undefined)?.find((action) => action.id === "retry-timeout-step");
			assert.deepEqual(retryAction?.params, { args: ["open", "https://example.test/fresh-timeout"], sessionMode: "fresh" });
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("collectTimeoutPartialProgress recovers live page state when session probes succeed", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "https://example.test/secret-token/results?token=url-secret" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "Results page export secret-token Authorization: Bearer title-secret" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		await mkdir(join(tempDir, "dogfood/secret-token"), { recursive: true });
		await writeFile(join(tempDir, "dogfood/secret-token/filled.png"), "fake image");
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const progress = await collectTimeoutPartialProgress({
				command: "batch",
				cwd: tempDir,
				sessionName: "named",
				stdin: JSON.stringify([
					["open", "https://example.test"],
					["screenshot", "dogfood/secret-token/filled.png"],
					["wait", "--download", "dogfood/export.csv"],
				]),
			});

			assert.ok(progress);
			assert.equal(progress.currentPage?.url, "https://example.test/secret-token/results?token=url-secret");
			assert.equal(progress.currentPage?.title, "Results page export secret-token Authorization: Bearer title-secret");
			assert.deepEqual(progress.artifacts.map((artifact) => ({ exists: artifact.exists, path: artifact.path, stepIndex: artifact.stepIndex })), [
				{ exists: true, path: "dogfood/secret-token/filled.png", stepIndex: 2 },
				{ exists: false, path: "dogfood/export.csv", stepIndex: 3 },
			]);
			const text = formatTimeoutPartialProgressText(progress);
			assert.match(text, /Current page: \[REDACTED\] — https:\/\/example.test\/\[REDACTED\]\/results\?token=%5BREDACTED%5D/);
			assert.doesNotMatch(text, /url-secret|title-secret|secret-token/);

			const compiledJob = compileAgentBrowserJob({
				steps: [
					{ action: "open", url: "https://example.test", loadState: "domcontentloaded" },
					{ action: "wait", milliseconds: 500 },
				],
			}).compiled;
			const generatedProgress = await collectTimeoutPartialProgress({ command: "batch", compiledJob, cwd: tempDir, sessionName: "named" });
			assert.equal(generatedProgress?.steps?.[1]?.generatedFrom, "open.loadState");
			assert.match(formatTimeoutPartialProgressText(generatedProgress as NonNullable<typeof generatedProgress>), /Step 2 \[failed, generated from open\.loadState\]: wait --load domcontentloaded/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("collectTimeoutPartialProgress falls back to the planned page URL when live page recovery is unavailable", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	try {
		for (const command of ["open", "goto", "navigate"] as const) {
			const progress = await collectTimeoutPartialProgress({
				command: "batch",
				cwd: tempDir,
				stdin: JSON.stringify([
					[command, `https://example.test/${command}-planned`],
					["screenshot", `${command}-planned.png`],
					["wait", "--download", `${command}-download.csv`],
				]),
			});

			assert.ok(progress, command);
			assert.equal(progress.currentPage?.url, `https://example.test/${command}-planned`, command);
			assert.equal(progress.currentPage?.source, "planned", command);
			assert.equal(progress.liveUrlRecovered, false, command);
			assert.equal(progress.currentPage?.title, undefined, command);
			assert.match(progress.summary, /planned page URL/, command);
			assert.deepEqual(progress.artifacts.map((artifact) => ({ exists: artifact.exists, path: artifact.path, stepIndex: artifact.stepIndex })), [
				{ exists: false, path: `${command}-planned.png`, stepIndex: 2 },
				{ exists: false, path: `${command}-download.csv`, stepIndex: 3 },
			], command);
			assert.match(formatTimeoutPartialProgressText(progress), new RegExp(`Current page: https://example\\.test/${command}-planned`), command);
		}
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension forwards wait --download saved-file metadata in details", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-wait-download-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`process.stdout.write(JSON.stringify({ success: true, data: { path: "/tmp/export.csv", elapsedMs: 64 } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["wait", "--download", "/tmp/export.csv"],
			});

			assert.equal(result.isError, true);
			assert.equal(result.content[0]?.type, "text");
			assert.match((result.content[0] as { text: string }).text, /Artifact verification failed: requested download was not found at \/tmp\/export\.csv/);
			assert.match((result.content[0] as { text: string }).text, /Download event reported; file not verified: \/tmp\/export\.csv/);
			assert.equal(result.details?.savedFilePath, "/tmp/export.csv");
			assert.deepEqual(result.details?.savedFile, {
				command: "wait",
				kind: "download",
				metadata: { elapsedMs: 64 },
				path: "/tmp/export.csv",
				subcommand: "--download",
			});
			assert.equal(result.details?.resultCategory, "failure");
			assert.equal(result.details?.failureCategory, "artifact-missing");
			assert.equal(result.details?.successCategory, undefined);
			assert.equal((result.details?.artifactVerification as { missingCount?: number; verified?: boolean } | undefined)?.missingCount, 1);
			assert.equal((result.details?.artifactVerification as { missingCount?: number; verified?: boolean } | undefined)?.verified, false);
			assert.deepEqual((result.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined)?.[0]?.params?.args, ["wait", "--download", "/tmp/export.csv"]);
			assert.equal((result.details?.pageChangeSummary as { changeType?: string; savedFilePath?: string } | undefined)?.changeType, "artifact");
			assert.equal((result.details?.pageChangeSummary as { changeType?: string; savedFilePath?: string } | undefined)?.savedFilePath, "/tmp/export.csv");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension reports artifact lifecycle guidance on close", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-artifact-cleanup-"));
	const screenshotPath = join(tempDir, "artifact.png");
	const deletedScreenshotPath = join(tempDir, "deleted-artifact.png");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("screenshot")) {
  const outputPath = args[args.length - 1];
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from("89504e470d0a1a0a", "hex"));
  process.stdout.write(JSON.stringify({ success: true, data: { path: outputPath } }));
} else if (args.includes("close")) {
  if (args.includes("--fail")) {
    process.stdout.write(JSON.stringify({ success: false, error: "close failed" }));
  } else {
    process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
  }
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example", url: "https://example.com/" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const screenshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["screenshot", screenshotPath] });
			assert.equal(screenshot.isError, false);
			const deletedScreenshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["screenshot", deletedScreenshotPath] });
			assert.equal(deletedScreenshot.isError, false);
			await rm(deletedScreenshotPath, { force: true });
			assert.equal((deletedScreenshot.details?.artifactManifest as { liveCount?: number } | undefined)?.liveCount, 2);

			const close = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
			assert.equal(close.isError, false);
			const text = (close.content[0] as { text: string }).text;
			assert.match(text, /Artifact lifecycle: 1 explicit artifact remains; expand or inspect details\.artifactCleanup\.explicitArtifactPaths for paths\./);
			assert.match(text, /Browser close does not delete explicit screenshots/);
			assert.doesNotMatch(text, /artifact\.png/);
			assert.doesNotMatch(text, /deleted-artifact\.png/);
			assert.deepEqual(close.details?.artifactCleanup, {
				explicitArtifactPaths: [screenshotPath],
				note: "Closing the browser session does not delete explicit screenshots, downloads, PDFs, traces, HAR files, or recordings; clean existing paths with host file tools when no longer needed.",
				owner: "host-file-tools",
				summary: String(close.details?.artifactRetentionSummary),
			});

			const failedClose = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close", "--fail"] });
			assert.equal(failedClose.isError, true);
			assert.doesNotMatch((failedClose.content[0] as { text: string }).text, /Artifact lifecycle:/);
			assert.equal(failedClose.details?.artifactCleanup, undefined);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension warns when get text may read hidden selector matches", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-get-text-visibility-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("get") && args.includes("text")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "npm init playwright@latest", origin: "https://docs.example/" } }));
} else if (args.includes("eval")) {
  const isAmbiguous = stdin.includes('.ambiguous-language-bash');
  process.stdout.write(JSON.stringify({ success: true, data: { result: JSON.stringify(isAmbiguous
    ? { selector: '.ambiguous-language-bash', matchCount: 2, visibleCount: 2, firstMatchVisible: true, firstTextPreview: "first visible", firstVisibleTextPreview: "first visible", visibleCandidates: [{ index: 0, tagName: "code", role: "tab", textPreview: "first visible" }, { index: 1, tagName: "code", textPreview: "second visible" }] }
    : { selector: '[href*="token=page-secret"]', matchCount: 2, visibleCount: 1, firstMatchVisible: false, firstTextPreview: "npm init playwright@latest", firstVisibleTextPreview: "yarn create playwright Authorization: Bearer visible-secret", visibleCandidates: [{ index: 1, tagName: "code", textPreview: "yarn create playwright Authorization: Bearer visible-secret" }] }) } }));
} else if (args.includes("batch")) {
  process.stdout.write(JSON.stringify({ success: true, data: [{ command: ["get", "text", ".ambiguous-language-bash"], success: true, result: { result: "first visible" } }, { command: ["get", "text", ".language-bash"], success: true, result: { result: "npm init playwright@latest" } }] }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "text", ".language-bash"] });
			assert.equal(result.isError, false);
			assert.match((result.content[0] as { text: string }).text, /npm init playwright@latest/);
			assert.match((result.content[0] as { text: string }).text, /Selector text visibility warning:/);
			assert.match((result.content[0] as { text: string }).text, /Next action: use details\.nextActions inspect-visible-text-candidates before trusting this selector text\./);
			assert.match((result.content[0] as { text: string }).text, /yarn create playwright/);
			assert.doesNotMatch((result.content[0] as { text: string }).text, /visible-secret|page-secret/);
			assert.deepEqual(result.details?.selectorTextVisibility, {
				firstMatchVisible: false,
				firstVisibleTextPreview: "yarn create playwright Authorization: Bearer [REDACTED]",
				matchCount: 2,
				selector: ".language-bash",
				summary: 'Selector ".language-bash" matched 2 elements; the first match is hidden while 1 visible match exists.',
				visibleCandidates: [{ index: 1, tagName: "code", textPreview: "yarn create playwright Authorization: Bearer [REDACTED]" }],
				visibleCount: 1,
			});
			assert.match((result.content[0] as { text: string }).text, /Visible candidates \(1 shown, querySelectorAll index\):/);
			assert.match((result.content[0] as { text: string }).text, /\[1\] code: "yarn create playwright Authorization: Bearer \[REDACTED\]"/);
			const nextActions = result.details?.nextActions as Array<{ id?: string; params?: { args?: string[]; stdin?: string } }> | undefined;
			assert.equal(nextActions?.at(-1)?.id, "inspect-visible-text-candidates");
			assert.deepEqual(nextActions?.at(-1)?.params?.args, ["--session", result.details?.sessionName as string, "eval", "--stdin"]);
			assert.match(nextActions?.at(-1)?.params?.stdin ?? "", /querySelectorAll/);

			const secretSelectorResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "text", '[href*="token=visible-secret"]'] });
			assert.equal(secretSelectorResult.isError, false);
			assert.doesNotMatch((secretSelectorResult.content[0] as { text: string }).text, /Selector text visibility warning|visible-secret/);
			assert.equal(secretSelectorResult.details?.selectorTextVisibility, undefined);
			const unquotedSecretSelectorResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["get", "text", "[data-token=visible-secret]"] });
			assert.equal(unquotedSecretSelectorResult.isError, false);
			assert.doesNotMatch((unquotedSecretSelectorResult.content[0] as { text: string }).text, /Selector text visibility warning|visible-secret/);
			assert.equal(unquotedSecretSelectorResult.details?.selectorTextVisibility, undefined);
			let invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, 1);

			const batchResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["batch"], stdin: JSON.stringify([["get", "text", ".ambiguous-language-bash"], ["get", "text", ".language-bash"]]) });
			assert.equal(batchResult.isError, false);
			assert.match((batchResult.content[0] as { text: string }).text, /Selector text visibility warning:/);
			assert.match((batchResult.content[0] as { text: string }).text, /Selector "\.language-bash" matched 2 elements; the first match is hidden/);
			assert.match((batchResult.content[0] as { text: string }).text, /Selector "\.ambiguous-language-bash" matched 2 elements; get text reads the first upstream match/);
			assert.match((batchResult.content[0] as { text: string }).text, /Next action: use details\.nextActions inspect-visible-text-candidates before trusting this selector text\./);
			assert.match((batchResult.content[0] as { text: string }).text, /Next action: use details\.nextActions inspect-visible-text-candidates-2 before trusting this selector text\./);
			assert.equal((batchResult.details?.selectorTextVisibility as { selector?: string } | undefined)?.selector, ".language-bash");
			assert.deepEqual((batchResult.details?.selectorTextVisibilityAll as Array<{ selector?: string }> | undefined)?.map((entry) => entry.selector), [".language-bash", ".ambiguous-language-bash"]);
			invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("eval")).length, 3);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension surfaces overlay blockers in snapshot actionability metadata", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-overlay-snapshot-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://blocked.example/",
    refs: {
      e5: { role: "button", name: "×" },
      e6: { role: "button", name: "Donate now" },
      e7: { role: "dialog", name: "Donation banner" }
    },
    snapshot: '- dialog "Donation banner" [ref=e7]\\n  - button "×" [ref=e5]\\n  - button "Donate now" [ref=e6]'
  } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Blocked Search", url: "https://blocked.example/" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
			assert.match(snapshot.content[0]?.text ?? "", /Possible overlay blockers:/);
			const overlayBlockers = snapshot.details?.overlayBlockers as { candidates?: Array<{ ref?: string }> } | undefined;
			assert.equal(overlayBlockers?.candidates?.[0]?.ref, "@e5");
			assert.ok((snapshot.details?.nextActions as Array<{ id?: string }> | undefined)?.some((action) => action.id === "try-overlay-blocker-candidate-1"));
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension surfaces likely overlay blockers after a no-op click", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-overlay-blocker-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Blocked Search", url: "https://blocked.example/" } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e9" } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Blocked Search", url: "https://blocked.example/" } } }));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://blocked.example/",
    refs: {
      e5: { role: "button", name: "×" },
      e6: { role: "button", name: "Donate now" },
      e7: { role: "dialog", name: "Donation banner" }
    },
    snapshot: '- dialog "Donation banner" [ref=e7]\\n  - button "×" [ref=e5]\\n  - button "Donate now" [ref=e6]'
  } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://blocked.example/"] });
			assert.equal(open.isError, false);

			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e9"] });
			assert.equal(click.isError, false);
			const text = click.content[0] as { text: string };
			assert.match(text.text, /Possible overlay blockers:/);
			assert.match(text.text, /@e5 button "×"/);
			assert.doesNotMatch(text.text, /Agent-browser candidate fallbacks:/);
			const overlayBlockers = click.details?.overlayBlockers as { candidates?: Array<{ ref?: string; args?: string[] }> } | undefined;
			assert.equal(overlayBlockers?.candidates?.[0]?.ref, "@e5");
			assert.deepEqual((click.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e5", "e6", "e7"]);
			const nextActions = click.details?.nextActions as Array<{ id?: string; params?: { args?: string[] } }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.id), ["inspect-after-mutation", "inspect-overlay-state", "try-overlay-blocker-candidate-1"]);
			assert.deepEqual(nextActions?.[1]?.params?.args, ["--session", click.details?.sessionName as string, "snapshot", "-i"]);
			assert.deepEqual(nextActions?.[2]?.params?.args, ["--session", click.details?.sessionName as string, "click", "@e5"]);

			const closeCandidateArgs = nextActions?.[2]?.params?.args;
			assert.ok(closeCandidateArgs);
			const closeCandidate = await executeRegisteredTool(harness.tool, harness.ctx, { args: closeCandidateArgs });
			assert.equal(closeCandidate.isError, false);
			assert.notEqual(closeCandidate.details?.failureCategory, "stale-ref");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension does not report overlay blockers from unrelated page chrome after a successful same-page click", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-overlay-noise-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Repo", url: "https://repo.example/" } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e9" } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Repo", url: "https://repo.example/" } } }));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://repo.example/",
    refs: {
      e1: { role: "link", name: "Skip to content" },
      e2: { role: "button", name: "Privacy choices" },
      e3: { role: "button", name: "Close banner" }
    },
    snapshot: '- link "Skip to content" [ref=e1]\\n- button "Privacy choices" [ref=e2]\\n- button "Close banner" [ref=e3]'
  } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://repo.example/"] });
			assert.equal(open.isError, false);
			const click = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e9"] });
			assert.equal(click.isError, false);
			const text = click.content[0] as { text: string };
			assert.doesNotMatch(text.text, /Possible overlay blockers:/);
			assert.equal(click.details?.overlayBlockers, undefined);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension returns tab-drift next actions for early tab re-selection failures", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tab-drift-next-actions-"));
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const args = process.argv.slice(2);
if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "target", title: "Example Domain", url: "https://example.com/", active: false }
  ] } }));
} else if (args.includes("tab") && args.includes("target")) {
  process.stdout.write(JSON.stringify({ success: false, error: "tab vanished" }));
  process.exit(1);
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "open", "https://example.com"],
							command: "open",
							sessionName: "named",
							sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(harness.handlers, "session_start", { reason: "resume" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session", "named", "eval", "--stdin"],
				stdin: "document.title",
			});

			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "tab-drift");
			const nextActions = result.details?.nextActions as Array<{ id: string; params?: { args: string[] } }> | undefined;
			assert.deepEqual(nextActions?.map((action) => action.id), ["list-tabs-for-tab-drift-recovery"]);
			assert.deepEqual(nextActions?.map((action) => action.params?.args), [
				["--session", "named", "tab", "list"],
			]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
