/**
 * Purpose: Verify prompt-derived browser artifact guards for the pi-agent-browser extension.
 * Responsibilities: Assert required prompt artifact close guards without semantic action blocking.
 * Scope: Integration-style Node test-runner coverage with fake agent-browser binaries.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
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

test("agentBrowserExtension does not turn prompt stop-boundary text into click blocks", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-no-semantic-prompt-block-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "https://shop.example/checkout-step-two", refs: { e9: { role: "button", name: "Finish" } }, snapshot: '- button "Finish" [ref=e9]' } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[args.length - 1] } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: "Stop on the checkout overview page; do not place the order." });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(snapshot.isError, false, JSON.stringify(snapshot));

			const refClick = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["click", "@e9"] });
			assert.equal(refClick.isError, false, JSON.stringify(refClick));
			assert.equal(refClick.details?.promptGuard, undefined);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension blocks close until required prompt screenshot artifacts are saved", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-required-artifact-"));
	const logPath = join(tempDir, "invocations.log");
	const screenshotPath = join(tempDir, "release-smoke.png");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("screenshot")) {
  const path = args[args.length - 1];
  fs.writeFileSync(path, "png");
  process.stdout.write(JSON.stringify({ success: true, data: { path } }));
} else if (args.includes("close")) {
  process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: `Save a screenshot here: ${screenshotPath}` });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const blockedClose = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
			assert.equal(blockedClose.isError, true);
			assert.match((blockedClose.content[0] as { text: string }).text, /requested artifact path is missing or unverified/);
			assert.equal((blockedClose.details?.promptGuard as { missingArtifacts?: Array<{ path?: string }> } | undefined)?.missingArtifacts?.[0]?.path, screenshotPath);

			const screenshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["screenshot", screenshotPath] });
			assert.equal(screenshot.isError, false, JSON.stringify(screenshot));
			assert.equal((await stat(screenshotPath)).isFile(), true);

			const close = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
			assert.equal(close.isError, false, JSON.stringify(close));

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("close")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension resolves relative prompt screenshot paths before allowing close", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-relative-artifact-"));
	const logPath = join(tempDir, "invocations.log");
	const relativeScreenshotPath = "./release-smoke.png";
	const absoluteScreenshotPath = join(tempDir, "release-smoke.png");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("screenshot")) {
  const path = args[args.length - 1];
  fs.writeFileSync(path, "png");
  process.stdout.write(JSON.stringify({ success: true, data: { path } }));
} else if (args.includes("close")) {
  process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir, prompt: `Save a screenshot here: ${relativeScreenshotPath}` });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const blockedClose = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
			assert.equal(blockedClose.isError, true);
			assert.equal((blockedClose.details?.promptGuard as { missingArtifacts?: Array<{ path?: string }> } | undefined)?.missingArtifacts?.[0]?.path, relativeScreenshotPath);

			const screenshot = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["screenshot", relativeScreenshotPath] });
			assert.equal(screenshot.isError, false, JSON.stringify(screenshot));
			assert.equal((await stat(absoluteScreenshotPath)).isFile(), true);

			const close = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
			assert.equal(close.isError, false, JSON.stringify(close));

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.filter((entry) => entry.args.includes("close")).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
