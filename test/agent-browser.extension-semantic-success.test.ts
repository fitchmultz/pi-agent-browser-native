/**
 * Purpose: Extension-level semanticAction success prose and navigation probe coverage.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

test("agentBrowserExtension enriches semanticAction click success with page state probe and prose parity", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-semantic-success-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const valueFlags = new Set(["--session"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const command = args[commandIndex];
if (command === "find") {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "[data-agent-browser-located='true']" } }));
} else if (command === "eval") {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Example Domain", url: "https://example.test/" } } }));
} else if (command === "click") {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: true, href: "https://example.test/docs", navigationSummary: { title: "Docs", url: "https://example.test/docs" } } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const semanticClick = await executeRegisteredTool(harness.tool, harness.ctx, {
				semanticAction: { action: "click", locator: "text", value: "Close" },
			});
			assert.equal(semanticClick.isError, false);
			const semanticText = (semanticClick.content[0] as { text: string }).text;
			assert.match(semanticText, /Clicked: text "Close"/);
			assert.doesNotMatch(semanticText, /data-agent-browser-located/);
			assert.match(semanticText, /Current page:/);
			assert.match(semanticText, /Example Domain/);
			assert.match(semanticText, /https:\/\/example.test\//);
			assert.match(semanticClick.details?.summary as string, /click → Example Domain/);
			assert.deepEqual(
				(semanticClick.details?.navigationSummary as { title?: string; url?: string } | undefined),
				{ title: "Example Domain", url: "https://example.test/" },
			);
			assert.equal(
				(semanticClick.details?.pageChangeSummary as { command?: string; changeType?: string } | undefined)?.command,
				"click",
			);
			assert.equal(
				(semanticClick.details?.pageChangeSummary as { command?: string; changeType?: string } | undefined)?.changeType,
				"navigation",
			);
			const nextActionIds = (semanticClick.details?.nextActions as Array<{ id: string }> | undefined)?.map((action) => action.id);
			assert.ok(nextActionIds?.includes("inspect-after-mutation"));

			const directClick = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["click", "#direct"],
			});
			assert.equal(directClick.isError, false);
			const directText = (directClick.content[0] as { text: string }).text;
			assert.match(directText, /Clicked: true/);
			assert.match(directText, /Href: https:\/\/example.test\/docs/);
			assert.match(directText, /Current page:/);

			const invocations = await readInvocationLog(logPath);
			const evalProbe = invocations.find((entry) => entry.args.includes("eval"));
			assert.ok(evalProbe, "expected read-only page-state eval after semantic click");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
