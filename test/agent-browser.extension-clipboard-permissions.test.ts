/**
 * Purpose: Verify clipboard permission-denial redaction at the extension entrypoint.
 * Responsibilities: Assert denied clipboard write payloads are removed from prose, details, batch rows, and parse-failure surfaces.
 * Scope: Focused fake-upstream coverage for clipboard permission failures.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-clipboard-permissions.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createExtensionHarness,
	executeRegisteredTool,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test("agentBrowserExtension redacts denied clipboard write payloads from all result surfaces", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-clipboard-denied-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
function clipboardError(command) {
  const payload = command.slice(2).join(" ");
  const message = "NotAllowedError: Failed to execute 'writeText' on 'Clipboard': Write permission denied for " + payload + ".";
  return payload.includes("object-secret") || payload === "a" ? { code: "NotAllowedError", message, payload, text: "safe metadata about clipboard denial", value: "safe value" } : message;
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
  if (args.includes("batch")) {
    const steps = JSON.parse(stdin);
    process.stdout.write(JSON.stringify(steps.map((command) => ({ command, success: false, error: clipboardError(command) }))));
  } else {
    process.stdout.write(JSON.stringify({ success: false, error: clipboardError(args.slice(args.indexOf("clipboard"))) }));
  }
});`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const standalone = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["clipboard", "write", "clipboard-secret"] });
			assert.equal(standalone.isError, true, JSON.stringify(standalone));
			assert.match((standalone.content[0] as { text: string }).text, /Agent-browser clipboard hint:/);
			assert.doesNotMatch(JSON.stringify(standalone), /clipboard-secret/);
			const firstInvocation = JSON.parse((await readFile(logPath, "utf8")).trim().split("\n")[0] ?? "{}");
			assert.deepEqual(firstInvocation.args.slice(-3), ["clipboard", "write", "clipboard-secret"]);

			const multiline = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["clipboard", "write", "clipboard-secret\nsecond-secret"] });
			assert.equal(multiline.isError, true, JSON.stringify(multiline));
			assert.doesNotMatch(JSON.stringify(multiline), /clipboard-secret|second-secret/);

			const objectError = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["clipboard", "write", "object-secret"] });
			assert.equal(objectError.isError, true, JSON.stringify(objectError));
			assert.doesNotMatch(JSON.stringify(objectError), /object-secret/);

			const shortPayload = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["clipboard", "write", "a"] });
			assert.equal(shortPayload.isError, true, JSON.stringify(shortPayload));
			assert.equal(shortPayload.details?.resultCategory, "failure");
			assert.equal(shortPayload.details?.failureCategory, "upstream-error");
			assert.equal(shortPayload.details?.command, "clipboard");
			assert.equal(shortPayload.details?.sessionMode, "auto");
			assert.match((shortPayload.content[0] as { text: string }).text, /Agent-browser clipboard hint:/);
			assert.doesNotMatch(JSON.stringify(shortPayload.details?.error), /permission denied for a\./);
			assert.match(JSON.stringify(shortPayload.details?.error), /safe metadata about clipboard denial/);
			assert.match(JSON.stringify(shortPayload.details?.error), /safe value/);

			const batch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["clipboard", "write", "clipboard-secret"]]),
			});
			assert.equal(batch.isError, true, JSON.stringify(batch));
			assert.match((batch.content[0] as { text: string }).text, /clipboard write \[REDACTED\]/);
			assert.doesNotMatch(JSON.stringify(batch), /clipboard-secret/);
			const invocations = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
			assert.equal(invocations.some((entry) => entry.stdin === JSON.stringify([["clipboard", "write", "clipboard-secret"]])), true);

			const multilineBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["clipboard", "write", "clipboard-secret\nsecond-secret"]]),
			});
			assert.equal(multilineBatch.isError, true, JSON.stringify(multilineBatch));
			assert.doesNotMatch(JSON.stringify(multilineBatch), /clipboard-secret|second-secret/);

			const objectErrorBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["clipboard", "write", "object-secret"]]),
			});
			assert.equal(objectErrorBatch.isError, true, JSON.stringify(objectErrorBatch));
			assert.doesNotMatch(JSON.stringify(objectErrorBatch), /object-secret/);

			const shortBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["batch"],
				stdin: JSON.stringify([["clipboard", "write", "a"]]),
			});
			assert.equal(shortBatch.isError, true, JSON.stringify(shortBatch));
			assert.equal(shortBatch.details?.resultCategory, "failure");
			assert.equal(shortBatch.details?.failureCategory, "upstream-error");
			assert.match((shortBatch.content[0] as { text: string }).text, /clipboard write \[REDACTED\]/);
			assert.doesNotMatch((shortBatch.content[0] as { text: string }).text, /permission denied for a\./);
			assert.match(JSON.stringify(shortBatch.details), /safe metadata about clipboard denial/);
			assert.match(JSON.stringify(shortBatch.details), /safe value/);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
