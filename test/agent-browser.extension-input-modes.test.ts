/**
 * Purpose: Verify high-level agent_browser input-mode compilation at the extension entrypoint.
 * Responsibilities: Assert semanticAction, visible-ref semantic resolution, constrained job, and lightweight QA compile/result contracts.
 * Scope: Integration-style Node test-runner coverage split out of the broad extension-validation suite; source/network lookup and validation-error tails remain in their focused suites.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-input-modes.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Check } from "typebox/value";

import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	runExtensionEventResults,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test("agentBrowserExtension compiles semantic actions to upstream find commands", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-action-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { args, title: "Clicked", url: "https://example.test/" } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const clickResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "role", value: "button", name: "Export" },
			});
			assert.equal(clickResult.isError, false);
			assert.deepEqual(clickResult.details?.compiledSemanticAction, {
				action: "click",
				locator: "role",
				args: ["find", "role", "button", "click", "--name", "Export"],
			});

			const roleOnlyClickResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "role", role: "button", name: "Continue without Signing In" },
			});
			assert.equal(roleOnlyClickResult.isError, false);
			assert.deepEqual(roleOnlyClickResult.details?.compiledSemanticAction, {
				action: "click",
				locator: "role",
				args: ["find", "role", "button", "click", "--name", "Continue without Signing In"],
			});

			const fillResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "fill", locator: "label", value: "Email", text: "user@example.test" },
			});
			assert.equal(fillResult.isError, false);
			assert.deepEqual(fillResult.details?.compiledSemanticAction, {
				action: "fill",
				locator: "label",
				args: ["find", "label", "Email", "fill", "user@example.test"],
			});

			const textClickResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "text", value: "Close" },
			});
			assert.equal(textClickResult.isError, false);
			assert.deepEqual(textClickResult.details?.compiledSemanticAction, {
				action: "click",
				locator: "text",
				args: ["find", "text", "Close", "click"],
			});

			const sessionClickResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "text", value: "Close", session: "named" },
			});
			assert.equal(sessionClickResult.isError, false);
			assert.deepEqual(sessionClickResult.details?.compiledSemanticAction, {
				action: "click",
				locator: "text",
				args: ["--session", "named", "find", "text", "Close", "click"],
			});
			assert.equal(sessionClickResult.details?.sessionName, "named");

			const selectResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "select", selector: "#flavor-select", value: "chocolate", session: "named" },
			});
			assert.equal(selectResult.isError, false);
			assert.deepEqual(selectResult.details?.compiledSemanticAction, {
				action: "select",
				selector: "#flavor-select",
				values: ["chocolate"],
				args: ["--session", "named", "select", "#flavor-select", "chocolate"],
			});
			assert.equal(selectResult.details?.sessionName, "named");

			const invocationLog = await readInvocationLog(logPath);
			const invocations = invocationLog.filter((entry) => entry.args.includes("find"));
			assert.deepEqual(invocations[0]?.args.slice(-6), ["find", "role", "button", "click", "--name", "Export"]);
			assert.deepEqual(invocations[1]?.args.slice(-6), ["find", "role", "button", "click", "--name", "Continue without Signing In"]);
			assert.deepEqual(invocations[2]?.args.slice(-5), ["find", "label", "Email", "fill", "user@example.test"]);
			assert.deepEqual(invocations[3]?.args.slice(-4), ["find", "text", "Close", "click"]);
			assert.deepEqual(invocations[4]?.args.slice(-6), ["--session", "named", "find", "text", "Close", "click"]);
			const selectInvocation = invocationLog.find((entry) => entry.args.includes("select"));
			assert.deepEqual(selectInvocation?.args.slice(-5), ["--session", "named", "select", "#flavor-select", "chocolate"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension resolves semantic role clicks through current visible snapshot refs when available", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-visible-ref-"));
	const logPath = join(tempDir, "invocations.log");
	const snapshotCountPath = join(tempDir, "snapshot-count.txt");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Docs", url: "https://docs.example.test/" } }));
} else if (args.includes("snapshot")) {
  const statePath = ${JSON.stringify(snapshotCountPath)};
  const count = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, "utf8")) : 0;
  fs.writeFileSync(statePath, String(count + 1));
  const refs = count === 0
    ? { e2: { role: "button", name: "Old Search Documentation" } }
    : { e17: { role: "button", name: "Search Documentation" } };
  const snapshot = count === 0
    ? '- button "Old Search Documentation" [ref=e2]'
    : '- button "Search Documentation" [ref=e17]';
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://docs.example.test/",
    refs,
    snapshot
  } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e17" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Docs" } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://docs.example.test/" } }));
} else if (args.includes("find")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "[data-agent-browser-located='true']" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const open = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://docs.example.test/"] });
			assert.equal(open.isError, false);
			const oldSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(oldSnapshot.isError, false);
			assert.deepEqual((oldSnapshot.details?.refSnapshot as { refIds?: string[] } | undefined)?.refIds, ["e2"]);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "role", value: "button", name: "Search Documentation" },
			});
			assert.equal(result.isError, false);
			assert.deepEqual(result.details?.compiledSemanticAction, {
				action: "click",
				locator: "role",
				args: ["find", "role", "button", "click", "--name", "Search Documentation"],
			});
			assert.deepEqual((result.details?.effectiveArgs as string[] | undefined)?.slice(-2), ["click", "@e17"]);
			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.includes("snapshot")));
			assert.ok(invocations.some((entry) => entry.args.at(-2) === "click" && entry.args.at(-1) === "@e17"));
			assert.equal(invocations.some((entry) => entry.args.includes("find")), false);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension compiles constrained jobs to upstream batch commands", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-job-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  const steps = JSON.parse(stdin);
  process.stdout.write(JSON.stringify(steps.map((command) => ({ command, success: true, result: { command } }))));
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: {
					steps: [
						{ action: "open", url: "https://example.test/" },
						{ action: "fill", selector: "#email", text: "user@example.test" },
						{ action: "select", selector: "#theme", values: ["dark", "compact"] },
						{ action: "click", selector: "#submit" },
						{ action: "assertText", text: "Welcome" },
						{ action: "assertUrl", url: "**/dashboard" },
						{ action: "wait", milliseconds: 250 },
						{ action: "waitForDownload", path: "report.csv" },
						{ action: "screenshot", path: "job.png" },
					],
				},
			});

			assert.equal(result.isError, false);
			assert.deepEqual(result.details?.args, ["batch"]);
			const effectiveArgs = result.details?.effectiveArgs as string[] | undefined;
			assert.deepEqual(effectiveArgs?.slice(0, 2), ["--json", "--session"]);
			assert.match(effectiveArgs?.[2] ?? "", /^piab-pi-agent-browser-job-/);
			assert.equal(effectiveArgs?.[3], "batch");
			const compiledJob = result.details?.compiledJob as { args?: string[]; stdin?: string; steps?: Array<{ action: string; args: string[] }> } | undefined;
			assert.deepEqual(compiledJob?.args, ["batch"]);
			const expectedCompiledSteps = [
				["open", "https://example.test/"],
				["fill", "#email", "user@example.test"],
				["select", "#theme", "dark", "compact"],
				["click", "#submit"],
				["wait", "--text", "Welcome"],
				["wait", "--url", "**/dashboard"],
				["wait", "250"],
				["wait", "--download", "report.csv"],
				["screenshot", "job.png"],
			];
			assert.deepEqual(compiledJob?.steps?.map((step) => step.args), expectedCompiledSteps);
			assert.deepEqual(JSON.parse(compiledJob?.stdin ?? "[]"), expectedCompiledSteps);
			const redactedResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				job: { steps: [{ action: "open", url: "https://user:secret@example.test/path?token=abc&ok=1#access_token=xyz" }] },
			});
			const redactedCompiledJob = redactedResult.details?.compiledJob as { stdin?: string; steps?: Array<{ args: string[] }> } | undefined;
			assert.match(redactedCompiledJob?.stdin ?? "", /%5BREDACTED%5D/);
			assert.doesNotMatch(redactedCompiledJob?.stdin ?? "", /secret|token=abc|access_token=xyz/);
			assert.deepEqual(JSON.parse(redactedCompiledJob?.stdin ?? "[]"), redactedCompiledJob?.steps?.map((step) => step.args));

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations[0]?.args.slice(-1), ["batch"]);
			const upstreamSteps = JSON.parse(invocations[0]?.stdin ?? "[]") as string[][];
			assert.deepEqual(upstreamSteps.slice(0, 8), compiledJob?.steps?.slice(0, 8).map((step) => step.args));
			assert.equal(upstreamSteps[8]?.[0], "screenshot");
			assert.match(upstreamSteps[8]?.[1] ?? "", /job\.png$/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension compiles lightweight QA presets and fails diagnostics", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-qa-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
let mode = "clean";
let staleNetwork = true;
let staleConsole = true;
let staleErrors = true;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  const steps = JSON.parse(stdin);
  const results = steps.map((command) => {
    const name = command[0];
    if (name === "open") {
      const url = String(command[1] || "");
      mode = url.includes("fail") ? "fail" : url.includes("favicon") ? "favicon" : "clean";
      return { command, success: true, result: { title: "QA Page", url } };
    }
    if (name === "network") {
      if (command.includes("--clear")) { staleNetwork = false; return { command, success: true, result: { requests: [] } }; }
      if (staleNetwork || mode === "fail") return { command, success: true, result: { requests: [{ method: "GET", resourceType: "fetch", status: 500, url: "https://example.test/api" }] } };
      if (mode === "favicon") return { command, success: true, result: { requests: [{ method: "GET", mimeType: "image/x-icon", status: 404, url: "https://example.test/favicon.ico" }] } };
      return { command, success: true, result: { requests: [] } };
    }
    if (name === "console") {
      if (command.includes("--clear")) { staleConsole = false; return { command, success: true, result: { messages: [] } }; }
      return { command, success: true, result: staleConsole || mode === "fail" ? { messages: [{ type: "error", text: "boom" }] } : { messages: [] } };
    }
    if (name === "errors") {
      if (command.includes("--clear")) { staleErrors = false; return { command, success: true, result: { errors: [] } }; }
      return { command, success: true, result: staleErrors || mode === "fail" ? { errors: [{ text: "page boom" }] } : { errors: [] } };
    }
    return { command, success: true, result: { ok: true } };
  });
  process.stdout.write(JSON.stringify(results));
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
			assert.equal(Check(harness.tool.parameters, { qa: { attached: true, expectedText: "Welcome" } }), true);
			assert.equal(Check(harness.tool.parameters, { qa: { attached: true, url: "https://example.test/" } }), false);
			assert.equal(Check(harness.tool.parameters, { qa: { expectedText: "Welcome" } }), false);
			const attachedWithoutSession = await executeRegisteredTool(harness.tool, harness.ctx, { qa: { attached: true, expectedText: "Welcome" } });
			assert.equal(attachedWithoutSession.isError, true);
			assert.match(attachedWithoutSession.content[0]?.text ?? "", /qa\.attached requires an active attached session/);
			assert.equal(attachedWithoutSession.details?.failureCategory, "validation-error");

			const cleanResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: {
					url: "https://example.test/",
					expectedText: ["Welcome"],
				},
			});
			assert.equal(cleanResult.isError, false);
			assert.deepEqual((cleanResult.details?.qaPreset as { failedChecks?: string[] } | undefined)?.failedChecks, []);

			const benignNetworkResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: {
					url: "https://favicon.example.test/",
					expectedText: ["Welcome"],
				},
			});
			assert.equal(benignNetworkResult.isError, false);
			assert.deepEqual((benignNetworkResult.details?.qaPreset as { failedChecks?: string[]; warnings?: string[] } | undefined)?.failedChecks, []);
			assert.deepEqual((benignNetworkResult.details?.qaPreset as { warnings?: string[] } | undefined)?.warnings, ["1 benign network request failure(s) ignored"]);
			assert.match((benignNetworkResult.content[0] as { text: string }).text, /QA preset passed with warnings: 1 benign network request failure\(s\) ignored\./);
			assert.match((benignNetworkResult.content[0] as { text: string }).text, /Network failure summary: 0 actionable, 1 benign low-impact \(1 total\)\./);
			assert.match((benignNetworkResult.content[0] as { text: string }).text, /404 GET https:\/\/example.test\/favicon.ico \(image\/x-icon\).*\[benign: low-impact browser icon asset\]/);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: {
					url: "https://fail.example.test/",
					expectedText: ["Welcome"],
					expectedSelector: "main",
					screenshotPath: "qa.png",
				},
				sessionMode: "fresh",
			});

			assert.equal(result.isError, true);
			assert.equal(result.details?.failureCategory, "qa-failure");
			const [realPiFailurePatch] = await runExtensionEventResults<{ content?: Array<{ text?: string; type: string }>; isError?: boolean }>(
				harness.handlers,
				"tool_result",
				{ content: result.content, details: result.details, isError: false, toolName: "agent_browser" },
			);
			assert.equal(realPiFailurePatch?.isError, true);
			assert.match(realPiFailurePatch?.content?.[0]?.text ?? "", /Result category: failure; failureCategory: qa-failure; Pi tool isError: true\./);

			const jsonFailureText = JSON.stringify({ error: "boom", success: false }, null, 2);
			const [jsonFailurePatch] = await runExtensionEventResults<{ content?: Array<{ text?: string; type: string }>; isError?: boolean }>(
				harness.handlers,
				"tool_result",
				{
					content: [{ type: "text", text: jsonFailureText }],
					details: { args: ["--json", "get", "url"], failureCategory: "upstream-error", resultCategory: "failure" },
					input: { args: ["--json", "get", "url"] },
					isError: false,
					toolName: "agent_browser",
				},
			);
			assert.equal(jsonFailurePatch?.isError, true);
			assert.equal(jsonFailurePatch?.content, undefined);
			assert.deepEqual(JSON.parse(jsonFailureText), { error: "boom", success: false });

			const [proseJsonArgsFailurePatch] = await runExtensionEventResults<{ content?: Array<{ text?: string; type: string }>; isError?: boolean }>(
				harness.handlers,
				"tool_result",
				{
					content: [{ type: "text", text: "Wrapper validation failed before upstream JSON output was available." }],
					details: { args: ["--json", "get", "url"], failureCategory: "validation-error", resultCategory: "failure" },
					input: { args: ["--json", "get", "url"] },
					isError: false,
					toolName: "agent_browser",
				},
			);
			assert.equal(proseJsonArgsFailurePatch?.isError, true);
			assert.match(proseJsonArgsFailurePatch?.content?.[0]?.text ?? "", /Result category: failure; failureCategory: validation-error; Pi tool isError: true\./);

			const managedSessionOutcome = result.details?.managedSessionOutcome as { sessionMode?: string; status?: string; succeeded?: boolean } | undefined;
			assert.equal(managedSessionOutcome?.sessionMode, "fresh");
			assert.equal(managedSessionOutcome?.status, "replaced");
			assert.equal(managedSessionOutcome?.succeeded, false);
			assert.match((result.content[0] as { text: string }).text, /Managed session outcome: Managed session .* was replaced by .*/);
			assert.deepEqual((result.details?.qaPreset as { failedChecks?: string[] } | undefined)?.failedChecks, [
				"1 actionable failed network request(s)",
				"1 console error message(s)",
				"1 page error(s)",
			]);
			const compiledQaPreset = result.details?.compiledQaPreset as { steps?: Array<{ args: string[] }> } | undefined;
			assert.deepEqual(compiledQaPreset?.steps?.map((step) => step.args), [
				["network", "requests", "--clear"],
				["console", "--clear"],
				["errors", "--clear"],
				["open", "https://fail.example.test/"],
				["wait", "--load", "domcontentloaded"],
				["wait", "--text", "Welcome"],
				["wait", "main"],
				["network", "requests"],
				["console"],
				["errors"],
				["screenshot", "qa.png"],
			]);
			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations[0]?.args.slice(-1), ["batch"]);
			assert.deepEqual(invocations[1]?.args.slice(-1), ["batch"]);
			assert.deepEqual(invocations[2]?.args.slice(-1), ["batch"]);

			const attachedResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: {
					attached: true,
					expectedText: "Welcome",
					expectedSelector: "main",
				},
			});
			assert.equal(attachedResult.isError, false);
			assert.match((attachedResult.content[0] as { text: string }).text, /QA attached target: .* — QA Page — https:\/\/fail\.example\.test\//);
			assert.equal((attachedResult.details?.qaAttachedTarget as { title?: string; url?: string } | undefined)?.title, "QA Page");
			assert.equal((attachedResult.details?.qaAttachedTarget as { title?: string; url?: string } | undefined)?.url, "https://fail.example.test/");
			const attachedCompiledQaPreset = attachedResult.details?.compiledQaPreset as { checks?: { attached?: boolean; url?: string }; steps?: Array<{ args: string[] }> } | undefined;
			assert.equal(attachedCompiledQaPreset?.checks?.attached, true);
			assert.equal(attachedCompiledQaPreset?.checks?.url, undefined);
			assert.deepEqual(attachedCompiledQaPreset?.steps?.map((step) => step.args), [
				["network", "requests", "--clear"],
				["console", "--clear"],
				["errors", "--clear"],
				["wait", "--load", "domcontentloaded"],
				["wait", "--text", "Welcome"],
				["wait", "main"],
				["network", "requests"],
				["console"],
				["errors"],
			]);
			const attachedInvocation = [...await readInvocationLog(logPath)].reverse().find((entry) => entry.args.at(-1) === "batch" && entry.stdin?.trim().startsWith("["));
			assert.ok(attachedInvocation);
			const attachedSteps = JSON.parse(attachedInvocation.stdin ?? "[]") as string[][];
			assert.equal(attachedSteps.some((step) => step[0] === "open"), false);

			const attachedFreshResult = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: { attached: true, expectedText: "Welcome" },
				sessionMode: "fresh",
			});
			assert.equal(attachedFreshResult.isError, true);
			assert.match(attachedFreshResult.content[0]?.text ?? "", /qa\.attached cannot be used with sessionMode=fresh/);
			assert.equal(attachedFreshResult.details?.failureCategory, "validation-error");

			const attachedWithUrl = await executeRegisteredTool(harness.tool, harness.ctx, {
				qa: { attached: true, url: "https://example.test/" },
			});
			assert.equal(attachedWithUrl.isError, true);
			assert.match(attachedWithUrl.content[0]?.text ?? "", /qa\.url must be omitted when qa\.attached is true/);
			assert.equal(attachedWithUrl.details?.failureCategory, "validation-error");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

