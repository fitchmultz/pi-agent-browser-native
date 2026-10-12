import { readArray, readRecord, readString } from "./helpers/assertions.js";
/**
 * Purpose: Verify extension entrypoint page-scoped ref guards and session target restoration.
 * Responsibilities: Assert stale-ref preflight, batch invalidation latches, no-active-page recovery, snapshot ref recording, and diagnostic URL filtering.
 * Scope: Integration-style Node test-runner coverage for ref/page-state behavior split out of the broad extension-validation suite.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-ref-guards.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests use fake agent-browser binaries and isolated env/temp directories to avoid relying on upstream browser behavior.
 */

import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, watch } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionPageState } from "../extensions/agent-browser/lib/session-page-state.js";

import {
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test(
	"agentBrowserExtension blocks page-scoped ref reuse after navigation before upstream can recycle it",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ref-generation-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://first.example/",
    refs: { e1: { role: "button", name: "Old Search" } },
    snapshot: '- button "Old Search" [ref=e1]'
  } }));
} else if (args.includes("get") && args.includes("url")) {
  const url = fs.existsSync(${JSON.stringify(join(tempDir, "navigated"))}) ? "https://second.example/" : "https://first.example/";
  process.stdout.write(JSON.stringify({ success: true, data: { url } }));
} else if (args.includes("open")) {
  fs.writeFileSync(${JSON.stringify(join(tempDir, "navigated"))}, "true");
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Second", url: "https://second.example/" } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "recycled ref" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				const snapshotDetails = readRecord(snapshot.details);
				assert.equal(snapshot.isError, false);
				assert.deepEqual(readRecord(snapshotDetails.refSnapshot ?? {}).refIds, ["e1"]);

				const currentClick = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				assert.equal(currentClick.isError, false);

				const open = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://second.example/"],
				});
				assert.equal(open.isError, false);

				const staleClick = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				const staleClickDetails = readRecord(staleClick.details);
				assert.equal(staleClick.isError, true);
				assert.equal(staleClickDetails.failureCategory, "stale-ref");
				assert.match(
					readString(readRecord(staleClick.content[0]).text),
					/came from a snapshot for https:\/\/first\.example\//,
				);
				assert.match(
					readString(readRecord(staleClick.content[0]).text),
					/current session target is https:\/\/second\.example\//,
				);
				const nextActions = readArray(staleClickDetails.nextActions ?? []).map((value) =>
					readRecord(value),
				);
				assert.deepEqual(readRecord(nextActions[0].params).args, [
					"--session",
					readString(staleClickDetails.sessionName),
					"snapshot",
					"-i",
				]);

				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 1);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension invalidates prior refs when a failed transition command keeps the page verified",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-failed-transition-refs-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://first.example/",
    refs: { e1: { role: "button", name: "Old Search" } },
    snapshot: '- button "Old Search" [ref=e1]'
  } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "https://first.example/", url: "https://first.example/" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "First", title: "First" } }));
} else if (args.includes("eval")) {
  process.stderr.write("SyntaxError: Identifier 'c' has already been declared");
  process.exit(1);
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: true } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				const snapshotDetails = readRecord(snapshot.details);
				assert.equal(snapshot.isError, false);
				assert.deepEqual(readRecord(snapshotDetails.refSnapshot ?? {}).refIds, ["e1"]);

				const failed = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["eval", "const c = 1;"],
				});
				const failedDetails = readRecord(failed.details);
				assert.equal(failed.isError, true);
				assert.equal(failedDetails.resultCategory, "failure");
				assert.equal(
					readRecord(failedDetails.sessionTabTarget ?? {}).url,
					"https://first.example/",
					JSON.stringify(failed),
				);

				// The live probe keeps the observed http(s) page verified, but the failed eval may still have
				// mutated the document before throwing, so the pre-change ref snapshot must be invalidated.
				const staleClick = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				const staleClickDetails = readRecord(staleClick.details);
				assert.equal(staleClick.isError, true);
				assert.equal(staleClickDetails.failureCategory, "stale-ref");
				assert.match(
					readString(readRecord(staleClick.content[0]).text),
					/may still have changed the page/,
				);

				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 0);
				assert.ok(
					invocations.some((entry) => entry.args.includes("get") && entry.args.includes("url")),
				);

				const refreshed = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				assert.equal(refreshed.isError, false);
				const currentClick = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				assert.equal(currentClick.isError, false);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension rehydrates page-scoped refs from the current tree branch",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tree-refs-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { clicked: true } }));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const firstTarget = { title: "First", url: "https://first.example/" };
				const secondTarget = { title: "Second", url: "https://second.example/" };
				const branchA = [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "snapshot", "-i"],
							command: "snapshot",
							refSnapshot: {
								refIds: ["e1"],
								refs: { e1: { name: "Old", role: "button" } },
								target: firstTarget,
							},
							sessionName: "named",
							sessionTabTarget: firstTarget,
						},
						isError: false,
					}),
				];
				const branchB = [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "snapshot", "-i"],
							command: "snapshot",
							refSnapshot: {
								refIds: ["e2"],
								refs: { e2: { name: "New", role: "button" } },
								target: secondTarget,
							},
							sessionName: "named",
							sessionTabTarget: secondTarget,
						},
						isError: false,
					}),
				];
				const harness = createExtensionHarness({ branch: branchA, cwd: tempDir });
				await runExtensionEvent(
					harness.handlers,
					"session_start",
					{ reason: "resume" },
					harness.ctx,
				);

				harness.setBranch(branchB);
				await runExtensionEvent(
					harness.handlers,
					"session_tree",
					{ newLeafId: "branch-b", oldLeafId: "branch-a" },
					harness.ctx,
				);

				const staleClick = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "named", "click", "@e1"],
				});
				const staleClickDetails = readRecord(staleClick.details);
				assert.equal(staleClick.isError, true);
				assert.equal(staleClickDetails.failureCategory, "stale-ref");
				assert.match(readString(staleClick.content[0].text ?? ""), /@e1/);
				assert.equal((await readInvocationLog(logPath)).length, 0);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension rehydrates managed browser session state from the current tree branch",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tree-managed-session-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("open")) {
  const url = args[args.length - 1];
  process.stdout.write(JSON.stringify({ success: true, data: { title: url.includes("second") ? "Second" : "First", url } }));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [{ tabId: "t1", url: "https://second.example/", title: "Second", active: true }] } }));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "https://snapshot.example/", refs: {}, snapshot: "" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const firstOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://first.example/"],
					sessionMode: "fresh",
				});
				const firstOpenDetails = readRecord(firstOpen.details);
				const firstSessionName = readString(firstOpenDetails.sessionName);
				const branchA = [...harness.ctx.sessionManager.getBranch()];
				const secondOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://second.example/"],
					sessionMode: "fresh",
				});
				const secondOpenDetails = readRecord(secondOpen.details);
				const secondSessionName = readString(secondOpenDetails.sessionName);
				const branchB = [...harness.ctx.sessionManager.getBranch()];
				assert.notEqual(firstSessionName, secondSessionName);

				harness.setBranch(branchA);
				await runExtensionEvent(
					harness.handlers,
					"session_start",
					{ reason: "resume" },
					harness.ctx,
				);
				harness.setBranch(branchB);
				await runExtensionEvent(
					harness.handlers,
					"session_tree",
					{ newLeafId: "branch-b", oldLeafId: "branch-a" },
					harness.ctx,
				);

				const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				const snapshotDetails = readRecord(snapshot.details);
				assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
				assert.equal(snapshotDetails.sessionName, secondSessionName);
				const lastInvocation = (await readInvocationLog(logPath)).at(-1);
				assert.deepEqual(lastInvocation?.args.slice(0, 3), [
					"--json",
					"--session",
					secondSessionName,
				]);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension rehydrates artifact manifest state from the current tree branch",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tree-artifacts-"));
		const logPath = join(tempDir, "invocations.log");
		const firstArtifact = join(tempDir, "first.png");
		const secondArtifact = join(tempDir, "second.png");
		const basePath = process.env.PATH ?? "";
		await writeFile(firstArtifact, "first", "utf8");
		await writeFile(secondArtifact, "second", "utf8");
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));`,
		);

		const buildManifest = (artifactPath: string) => ({
			entries: [
				{
					absolutePath: artifactPath,
					command: "screenshot",
					createdAtMs: 1,
					cwd: tempDir,
					kind: "image",
					path: artifactPath,
					retentionState: "live",
					storageScope: "explicit-path",
				},
			],
			evictedCount: 0,
			liveCount: 1,
			maxEntries: 100,
			updatedAtMs: 1,
			version: 1,
		});

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const branchA = [
					createToolBranchEntry({
						details: {
							artifactManifest: buildManifest(firstArtifact),
							args: ["screenshot", firstArtifact],
							command: "screenshot",
							sessionName: "named",
						},
						isError: false,
					}),
				];
				const branchB = [
					createToolBranchEntry({
						details: {
							artifactManifest: buildManifest(secondArtifact),
							args: ["screenshot", secondArtifact],
							command: "screenshot",
							sessionName: "named",
						},
						isError: false,
					}),
				];
				const harness = createExtensionHarness({ branch: branchA, cwd: tempDir });
				await runExtensionEvent(
					harness.handlers,
					"session_start",
					{ reason: "resume" },
					harness.ctx,
				);

				harness.setBranch(branchB);
				await runExtensionEvent(
					harness.handlers,
					"session_tree",
					{ newLeafId: "branch-b", oldLeafId: "branch-a" },
					harness.ctx,
				);

				const close = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "named", "close"],
				});
				const closeDetails = readRecord(close.details);
				assert.equal(close.isError, false, JSON.stringify(close));
				assert.deepEqual(readRecord(closeDetails.artifactCleanup ?? {}).explicitArtifactPaths, [
					secondArtifact,
				]);
				assert.doesNotMatch(
					readString(close.content[0].text ?? ""),
					new RegExp(firstArtifact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension recommends tab recovery after No active page snapshot failures",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-no-active-page-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
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
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, command }) + "\\n");
const snapshotStatePath = ${JSON.stringify(join(tempDir, "snapshot-count.txt"))};
function nextSnapshotCount() {
  let count = 0;
  try { count = Number(fs.readFileSync(snapshotStatePath, "utf8")) || 0; } catch {}
  count += 1;
  fs.writeFileSync(snapshotStatePath, String(count));
  return count;
}
if (command === "connect") {
  process.stdout.write(JSON.stringify({ success: true, data: { connected: true } }));
} else if (command === "get" && args[commandIndex + 1] === "url") {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "https://active.example/" } }));
} else if (command === "snapshot") {
  const snapshotCount = nextSnapshotCount();
  if (snapshotCount === 1) {
    process.stdout.write(JSON.stringify({ success: true, data: {
      origin: "https://active.example/",
      refs: { e1: { role: "button", name: "Old action" } },
      snapshot: '- button "Old action" [ref=e1]'
    } }));
  } else if (snapshotCount === 2) {
    process.stdout.write(JSON.stringify({ success: false, error: "No active page" }));
    process.exit(1);
  } else {
    process.stdout.write(JSON.stringify({ success: true, data: {
      origin: "https://active.example/",
      refs: { e2: { role: "button", name: "Fresh action" } },
      snapshot: '- button "Fresh action" [ref=e2]'
    } }));
  }
} else if (command === "click") {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[args.length - 1] } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const connectResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["connect", "9222"],
				});
				const connectResultDetails = readRecord(connectResult.details);
				assert.equal(connectResult.isError, false);
				const sessionName = readString(connectResultDetails.sessionName);
				assert.ok(sessionName.length > 0);
				const verifiedUrl = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "url"],
				});
				assert.equal(verifiedUrl.isError, false, JSON.stringify(verifiedUrl));

				const initialSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				const initialSnapshotDetails = readRecord(initialSnapshot.details);
				assert.equal(initialSnapshot.isError, false, JSON.stringify(initialSnapshot));
				assert.deepEqual(readRecord(initialSnapshotDetails.refSnapshot ?? {}).refIds, ["e1"]);
				assert.equal("order" in readRecord(initialSnapshotDetails.refSnapshot ?? {}), false);

				const snapshotResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				const snapshotResultDetails = readRecord(snapshotResult.details);
				assert.equal(snapshotResult.isError, true);
				assert.equal(snapshotResultDetails.command, "snapshot");
				assert.equal(snapshotResultDetails.failureCategory, "upstream-error");
				assert.equal(snapshotResultDetails.refSnapshot, undefined);
				assert.equal(
					readRecord(snapshotResultDetails.refSnapshotInvalidation ?? {}).reason,
					"no-active-page",
				);
				assert.equal(
					"order" in readRecord(snapshotResultDetails.refSnapshotInvalidation ?? {}),
					false,
				);
				const nextActions = readArray(snapshotResultDetails.nextActions ?? []).map((value) =>
					readRecord(value),
				);
				assert.deepEqual(
					nextActions.map((action) => action.id),
					["list-tabs-after-no-active-page"],
				);
				assert.deepEqual(
					nextActions.map((action) => readRecord(action.params).args),
					[["--session", sessionName, "tab", "list"]],
				);

				const staleClick = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				const staleClickDetails = readRecord(staleClick.details);
				assert.equal(staleClick.isError, true);
				assert.equal(staleClickDetails.failureCategory, "stale-ref");
				assert.deepEqual(staleClickDetails.refIds, ["e1"]);
				assert.equal(
					readRecord(staleClickDetails.refSnapshotInvalidation ?? {}).reason,
					"no-active-page",
				);
				assert.equal("order" in readRecord(staleClickDetails.refSnapshotInvalidation ?? {}), false);
				assert.match(
					readString(readRecord(staleClick.content[0]).text),
					/latest snapshot for this session reported No active page/,
				);
				const staleNextActions = readArray(staleClickDetails.nextActions ?? []).map((value) =>
					readRecord(value),
				);
				assert.deepEqual(
					staleNextActions.map((action) => action.id),
					["refresh-interactive-refs"],
				);
				assert.deepEqual(
					staleNextActions.map((action) => readRecord(action.params).args),
					[["--session", sessionName, "snapshot", "-i"]],
				);

				const batchWithInlineSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["snapshot", "-i"],
						["click", "@e1"],
					]),
				});
				const batchWithInlineSnapshotDetails = readRecord(batchWithInlineSnapshot.details);
				assert.equal(batchWithInlineSnapshot.isError, true);
				assert.equal(batchWithInlineSnapshotDetails.failureCategory, "stale-ref");
				assert.deepEqual(batchWithInlineSnapshotDetails.refIds, ["e1"]);
				assert.match(
					readString(readRecord(batchWithInlineSnapshot.content[0]).text),
					/latest snapshot for this session reported No active page/,
				);

				const freshSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				const freshSnapshotDetails = readRecord(freshSnapshot.details);
				assert.equal(freshSnapshot.isError, false, JSON.stringify(freshSnapshot));
				assert.equal(freshSnapshotDetails.refSnapshotInvalidation, undefined);
				assert.deepEqual(readRecord(freshSnapshotDetails.refSnapshot ?? {}).refIds, ["e2"]);
				assert.equal("order" in readRecord(freshSnapshotDetails.refSnapshot ?? {}), false);

				const freshClick = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e2"],
				});
				const freshClickDetails = readRecord(freshClick.details);
				assert.equal(freshClick.isError, false, JSON.stringify(freshClick));
				assert.equal(readRecord(freshClickDetails.data ?? {}).clicked, "@e2");

				const invocations = await readInvocationLog(logPath);
				assert.deepEqual(
					invocations
						.map((entry) =>
							entry.args.find((token) => ["connect", "snapshot", "click"].includes(token)),
						)
						.filter((command): command is string => command !== undefined),
					["connect", "snapshot", "snapshot", "snapshot", "snapshot", "click"],
				);
				assert.equal(
					invocations.filter(
						(entry) => entry.args.at(-2) === "click" && entry.args.at(-1) === "@e2",
					).length,
					1,
				);
				assert.equal(invocations.filter((entry) => entry.args.includes("@e1")).length, 0);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension invalidates refs after No active page snapshot failures inside batch",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-no-active-page-batch-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
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
const recoveredPath = ${JSON.stringify(join(tempDir, "recovered.flag"))};
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, command, stdin }) + "\\n");
if (command === "connect") {
	process.stdout.write(JSON.stringify({ success: true, data: { connected: true } }));
} else if (command === "get" && args[commandIndex + 1] === "url") {
	process.stdout.write(JSON.stringify({ success: true, data: { result: "https://active.example/" } }));
} else if (command === "snapshot") {
	const recovered = fs.existsSync(recoveredPath);
	process.stdout.write(JSON.stringify({ success: true, data: recovered ? {
	origin: "https://active.example/",
	refs: { e2: { role: "button", name: "Recovered action" } },
	snapshot: '- button "Recovered action" [ref=e2]'
	} : {
	origin: "https://active.example/",
	refs: { e1: { role: "button", name: "Old action" } },
	snapshot: '- button "Old action" [ref=e1]'
	} }));
} else if (command === "batch") {
	const steps = JSON.parse(stdin || "[]");
	process.stdout.write(JSON.stringify(steps.map((step) => {
		if (step[0] === "snapshot" && step.includes("--recover")) {
			fs.writeFileSync(recoveredPath, "1");
			return { command: step, success: true, result: {
				origin: "https://active.example/",
				refs: { e2: { role: "button", name: "Recovered action" } },
				snapshot: '- button "Recovered action" [ref=e2]'
			} };
		}
		return step[0] === "snapshot"
			? { command: step, success: false, error: "No active page" }
			: { command: step, success: true, result: { ok: true } };
	})));
	process.exit(1);
} else if (command === "click") {
	process.stdout.write(JSON.stringify({ success: true, data: { clicked: args[args.length - 1] } }));
} else {
	process.stdout.write(JSON.stringify({ success: true, data: { ok: true } }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const connectResult = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["connect", "9222"],
				});
				const connectResultDetails = readRecord(connectResult.details);
				assert.equal(connectResult.isError, false);
				const sessionName = readString(connectResultDetails.sessionName);
				assert.ok(sessionName.length > 0);
				const verifiedUrl = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "url"],
				});
				assert.equal(verifiedUrl.isError, false, JSON.stringify(verifiedUrl));

				const initialSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				const initialSnapshotDetails = readRecord(initialSnapshot.details);
				assert.equal(initialSnapshot.isError, false, JSON.stringify(initialSnapshot));
				assert.deepEqual(readRecord(initialSnapshotDetails.refSnapshot ?? {}).refIds, ["e1"]);
				assert.equal("order" in readRecord(initialSnapshotDetails.refSnapshot ?? {}), false);

				const batchSnapshotFailure = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([["snapshot", "-i"]]),
				});
				const batchSnapshotFailureDetails = readRecord(batchSnapshotFailure.details);
				assert.equal(batchSnapshotFailure.isError, true, JSON.stringify(batchSnapshotFailure));
				assert.equal(batchSnapshotFailureDetails.refSnapshot, undefined);
				assert.equal(
					readRecord(batchSnapshotFailureDetails.refSnapshotInvalidation ?? {}).reason,
					"no-active-page",
				);
				assert.equal(
					"order" in readRecord(batchSnapshotFailureDetails.refSnapshotInvalidation ?? {}),
					false,
				);
				const nextActions = readArray(batchSnapshotFailureDetails.nextActions ?? []).map((value) =>
					readRecord(value),
				);
				assert.deepEqual(
					nextActions.map((action) => action.id),
					["list-tabs-after-no-active-page"],
				);
				assert.deepEqual(
					nextActions.map((action) => readRecord(action.params).args),
					[["--session", sessionName, "tab", "list"]],
				);

				const staleClick = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				const staleClickDetails = readRecord(staleClick.details);
				assert.equal(staleClick.isError, true);
				assert.equal(staleClickDetails.failureCategory, "stale-ref");
				assert.deepEqual(staleClickDetails.refIds, ["e1"]);
				assert.equal(
					readRecord(staleClickDetails.refSnapshotInvalidation ?? {}).reason,
					"no-active-page",
				);
				assert.equal("order" in readRecord(staleClickDetails.refSnapshotInvalidation ?? {}), false);

				const batchSnapshotRecovery = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["snapshot", "-i"],
						["snapshot", "-i", "--recover"],
					]),
				});
				const batchSnapshotRecoveryDetails = readRecord(batchSnapshotRecovery.details);
				assert.equal(batchSnapshotRecovery.isError, true, JSON.stringify(batchSnapshotRecovery));
				assert.equal(batchSnapshotRecoveryDetails.refSnapshotInvalidation, undefined);
				assert.deepEqual(readRecord(batchSnapshotRecoveryDetails.refSnapshot ?? {}).refIds, ["e2"]);
				assert.equal("order" in readRecord(batchSnapshotRecoveryDetails.refSnapshot ?? {}), false);

				const recoveredClick = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e2"],
				});
				const recoveredClickDetails = readRecord(recoveredClick.details);
				assert.equal(recoveredClick.isError, false, JSON.stringify(recoveredClick));
				assert.equal(readRecord(recoveredClickDetails.data ?? {}).clicked, "@e2");

				const invocations = await readInvocationLog(logPath);
				assert.deepEqual(
					invocations
						.map((entry) =>
							entry.args.find((token) => ["connect", "snapshot", "batch", "click"].includes(token)),
						)
						.filter((command): command is string => command !== undefined),
					["connect", "snapshot", "batch", "batch", "snapshot", "click"],
				);
				assert.equal(invocations.filter((entry) => entry.args.includes("@e1")).length, 0);
				assert.equal(invocations.filter((entry) => entry.args.includes("@e2")).length, 1);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension keeps network request diagnostics from replacing the active page target",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-network-request-target-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const appTarget = "https://app.example/";
const apiTarget = "https://app.example/api/data";
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: appTarget,
    refs: { e1: { role: "button", name: "Refresh data" } },
    snapshot: '- button "Refresh data" [ref=e1]'
  } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: appTarget } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "" } }));
} else if (args.includes("network") && args.includes("request")) {
  process.stdout.write(JSON.stringify({ success: true, data: { id: "42", method: "GET", status: 500, url: apiTarget, error: "server error" } }));
} else if (args.includes("errors")) {
  process.stdout.write(JSON.stringify({ success: true, data: { errors: [], url: "https://cdn.example/app.js" } }));
} else if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  process.stdout.write(JSON.stringify(steps.map((step) => {
    if (step[0] === "network" && step[1] === "request") {
      return { command: step, success: true, result: { id: step[2], method: "GET", status: 500, url: apiTarget, error: "server error" } };
    }
    if (step[0] === "network" && step[1] === "requests") {
      return { command: step, success: true, result: { requests: [{ id: "42", method: "GET", status: 500, url: apiTarget, error: "server error" }] } };
    }
    return { command: step, success: true, result: { ok: step[0] } };
  })));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e1" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				const snapshotDetails = readRecord(snapshot.details);
				assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
				assert.deepEqual(snapshotDetails.sessionTabTarget, {
					title: undefined,
					url: "https://app.example/",
				});

				const networkRequest = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["network", "request", "42"],
				});
				const networkRequestDetails = readRecord(networkRequest.details);
				assert.equal(networkRequest.isError, false, JSON.stringify(networkRequest));
				assert.deepEqual(networkRequestDetails.sessionTabTarget, {
					title: undefined,
					url: "https://app.example/",
				});
				assert.equal(networkRequestDetails.refSnapshot, undefined);
				assert.deepEqual(
					SessionPageState.fromBranch(harness.ctx.sessionManager.getBranch()).get(
						readString(networkRequestDetails.sessionName),
					).refSnapshot?.refIds,
					["e1"],
				);

				const pageErrors = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["errors"],
				});
				const pageErrorsDetails = readRecord(pageErrors.details);
				assert.equal(pageErrors.isError, false, JSON.stringify(pageErrors));
				assert.deepEqual(pageErrorsDetails.sessionTabTarget, {
					title: undefined,
					url: "https://app.example/",
				});

				const clickAfterNetworkRequest = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				const clickAfterNetworkRequestDetails = readRecord(clickAfterNetworkRequest.details);
				assert.equal(
					clickAfterNetworkRequest.isError,
					false,
					JSON.stringify(clickAfterNetworkRequest),
				);
				assert.notEqual(clickAfterNetworkRequestDetails.failureCategory, "stale-ref");
				assert.equal(readRecord(clickAfterNetworkRequestDetails.data ?? {}).clicked, "@e1");

				const networkSourceLookup = await executeRegisteredTool(harness.tool, harness.ctx, {
					networkSourceLookup: { requestId: "42" },
				});
				const networkSourceLookupDetails = readRecord(networkSourceLookup.details);
				assert.equal(networkSourceLookup.isError, false, JSON.stringify(networkSourceLookup));
				assert.deepEqual(networkSourceLookupDetails.sessionTabTarget, {
					title: undefined,
					url: "https://app.example/",
				});
				assert.equal(networkSourceLookupDetails.refSnapshot, undefined);
				assert.deepEqual(
					SessionPageState.fromBranch(harness.ctx.sessionManager.getBranch()).get(
						readString(networkSourceLookupDetails.sessionName),
					).refSnapshot?.refIds,
					["e1"],
				);

				const clickAfterNetworkSourceLookup = await executeRegisteredTool(
					harness.tool,
					harness.ctx,
					{ args: ["click", "@e1"] },
				);
				const clickAfterNetworkSourceLookupDetails = readRecord(
					clickAfterNetworkSourceLookup.details,
				);
				assert.equal(
					clickAfterNetworkSourceLookup.isError,
					false,
					JSON.stringify(clickAfterNetworkSourceLookup),
				);
				assert.notEqual(clickAfterNetworkSourceLookupDetails.failureCategory, "stale-ref");

				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 2);
				assert.equal(
					invocations.filter(
						(entry) => entry.args.includes("network") && entry.args.includes("request"),
					).length,
					1,
				);
				assert.equal(invocations.filter((entry) => entry.args.includes("batch")).length, 1);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension ignores restored diagnostic session targets that contain request URLs",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-network-request-restore-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "https://app.example/", snapshot: '- button "Refresh" [ref=e1]', refs: { e1: { role: "button", name: "Refresh" } } } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://app.example/" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "" } }));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [{ tabId: "t1", url: "https://app.example/", active: true }] } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e1" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const appTarget = { title: undefined, url: "https://app.example/" };
				const seed = createExtensionHarness({ cwd: tempDir });
				const capture = await executeRegisteredTool(seed.tool, seed.ctx, {
					args: ["--session", "named", "snapshot", "-i"],
				});
				const captureDetails = readRecord(capture.details);
				assert.equal(capture.isError, false, JSON.stringify(capture));
				const harness = createExtensionHarness({
					branch: [
						createToolBranchEntry({
							details: {
								args: ["--session", "named", "open", "https://app.example/"],
								command: "open",
								sessionName: "named",
								sessionTabTarget: appTarget,
							},
							isError: false,
						}),
						createToolBranchEntry({
							details: {
								args: ["--session", "named", "snapshot", "-i"],
								command: "snapshot",
								refSnapshot: captureDetails.refSnapshot,
								sessionName: "named",
								sessionTabTarget: appTarget,
							},
							isError: false,
						}),
						createToolBranchEntry({
							details: {
								args: ["--session", "named", "network", "request", "42"],
								command: "network",
								refSnapshot: captureDetails.refSnapshot,
								sessionName: "named",
								sessionTabTarget: { title: undefined, url: "https://app.example/api/data" },
								subcommand: "request",
							},
							isError: false,
						}),
						createToolBranchEntry({
							details: {
								args: ["batch"],
								command: "batch",
								compiledNetworkSourceLookup: {
									args: ["batch"],
									query: { requestId: "42" },
									steps: [],
									stdin: "[]",
								},
								data: [
									{
										command: ["network", "request", "42"],
										result: {
											error: "server error",
											id: "42",
											status: 500,
											url: "https://app.example/api/data",
										},
										success: true,
									},
								],
								refSnapshot: captureDetails.refSnapshot,
								sessionName: "named",
								sessionTabTarget: { title: undefined, url: "https://app.example/api/data" },
							},
							isError: false,
						}),
					],
					cwd: tempDir,
				});
				await runExtensionEvent(
					harness.handlers,
					"session_start",
					{ reason: "resume" },
					harness.ctx,
				);

				const click = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "named", "click", "@e1"],
				});
				const clickDetails = readRecord(click.details);
				assert.equal(click.isError, false, JSON.stringify(click));
				assert.notEqual(clickDetails.failureCategory, "stale-ref");
				assert.equal(readRecord(clickDetails.sessionTabTarget).url, appTarget.url);
				assert.equal(clickDetails.refSnapshot, undefined);
				const restoredSnapshot = SessionPageState.fromBranch(
					harness.ctx.sessionManager.getBranch(),
				).get("named").refSnapshot;
				assert.deepEqual(restoredSnapshot?.refIds, ["e1"]);
				assert.equal("order" in restoredSnapshot, false);

				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 1);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension restores empty successful batch snapshots as ref state",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-empty-ref-restore-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("click")) {
	process.stdout.write(JSON.stringify({ success: true, data: { clicked: args.at(-1) } }));
} else {
	process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const appTarget = { title: undefined, url: "https://empty.example/" };
				const harness = createExtensionHarness({
					branch: [
						createToolBranchEntry({
							details: {
								args: ["--session", "named", "snapshot", "-i"],
								command: "snapshot",
								refSnapshotInvalidation: {
									reason: "no-active-page",
									summary:
										"The latest snapshot for this session reported No active page. Old page-scoped refs are invalid until snapshot -i succeeds.",
								},
								sessionName: "named",
							},
							isError: true,
						}),
						createToolBranchEntry({
							details: {
								args: ["batch"],
								command: "batch",
								data: [
									{
										command: ["snapshot", "-i"],
										result: { origin: appTarget.url, refs: {}, snapshot: "" },
										success: true,
									},
								],
								refSnapshot: { refIds: [], target: appTarget },
								sessionName: "named",
								sessionTabTarget: appTarget,
							},
							isError: false,
						}),
					],
					cwd: tempDir,
				});
				await runExtensionEvent(
					harness.handlers,
					"session_start",
					{ reason: "resume" },
					harness.ctx,
				);

				const click = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "named", "click", "@e1"],
				});
				const clickDetails = readRecord(click.details);
				assert.equal(click.isError, true);
				assert.equal(clickDetails.failureCategory, "stale-ref");
				assert.deepEqual(clickDetails.refIds, ["e1"]);
				assert.equal(clickDetails.refSnapshot, undefined);
				assert.deepEqual(
					SessionPageState.fromBranch(harness.ctx.sessionManager.getBranch()).get("named")
						.refSnapshot?.refIds,
					[],
				);
				assert.equal(clickDetails.refSnapshotInvalidation, undefined);
				assert.match(
					readString(readRecord(click.content[0]).text),
					/was not present in the latest snapshot/,
				);

				const invocations = await readInvocationLog(logPath).catch(() => []);
				assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 0);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension treats successful snapshots without refs as empty ref state",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-missing-refs-snapshot-"));
		const logPath = join(tempDir, "invocations.log");
		const statePath = join(tempDir, "snapshot-count.txt");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
	let count = 0;
	try { count = Number(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
	count += 1;
	fs.writeFileSync(${JSON.stringify(statePath)}, String(count));
	if (count === 1) {
	process.stdout.write(JSON.stringify({ success: true, data: {
		origin: "https://missing-refs.example/",
		refs: { e1: { role: "button", name: "Old Search" } },
		snapshot: '- button "Old Search" [ref=e1]'
	} }));
	} else {
	process.stdout.write(JSON.stringify({ success: true, data: {
		origin: "https://missing-refs.example/",
		snapshot: 'No interactive controls are visible.'
	} }));
	}
} else if (args.includes("get") && args.includes("url")) {
	process.stdout.write(JSON.stringify({ success: true, data: { url: "https://missing-refs.example/" } }));
} else if (args.includes("click")) {
	process.stdout.write(JSON.stringify({ success: true, data: { clicked: args.at(-1) } }));
} else {
	process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const firstSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				const firstSnapshotDetails = readRecord(firstSnapshot.details);
				assert.equal(firstSnapshot.isError, false, JSON.stringify(firstSnapshot));
				assert.deepEqual(readRecord(firstSnapshotDetails.refSnapshot ?? {}).refIds, ["e1"]);

				const missingRefClick = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e9"],
				});
				assert.equal(missingRefClick.isError, true);
				assert.equal(missingRefClick.details?.failureCategory, "stale-ref");
				assert.match(
					readString(missingRefClick.content[0].text),
					/Ref @e9 was not present in the latest snapshot/,
				);
				assert.equal(
					(await readInvocationLog(logPath)).some((entry) => entry.args.includes("click")),
					false,
				);

				const emptySnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				const emptySnapshotDetails = readRecord(emptySnapshot.details);
				assert.equal(emptySnapshot.isError, false, JSON.stringify(emptySnapshot));
				assert.deepEqual(readRecord(emptySnapshotDetails.refSnapshot ?? {}).refIds, []);

				const staleClick = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				const staleClickDetails = readRecord(staleClick.details);
				assert.equal(staleClick.isError, true, JSON.stringify(staleClick));
				assert.equal(staleClickDetails.failureCategory, "stale-ref");
				assert.match(
					readString(readRecord(staleClick.content[0]).text),
					/was not present in the latest snapshot/,
				);
				assert.equal(staleClickDetails.refSnapshot, undefined);
				assert.deepEqual(
					SessionPageState.fromBranch(harness.ctx.sessionManager.getBranch()).get(
						readString(staleClickDetails.sessionName),
					).refSnapshot?.refIds,
					[],
				);

				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 0);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension blocks stale refs after page-changing steps inside a batch",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ref-batch-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://first.example/",
    refs: { e1: { role: "button", name: "Old Search" }, e2: { role: "textbox", name: "Value" } },
    snapshot: '- button "Old Search" [ref=e1]\\n- textbox "Value" [ref=e2]'
  } }));
} else if (args.includes("batch")) {
  const raw = args.slice(args.indexOf("batch") + 1).filter(arg => arg !== "--bail");
  const steps = raw.length ? raw.map(row => row.split(" ")) : JSON.parse(stdin);
  process.stdout.write(JSON.stringify(steps.map(command => ({ command, success: true, result:
    command[0] === "snapshot" ? {
      origin: "https://first.example/",
      refs: { e1: { role: "button", name: "Old Search" }, e2: { role: "textbox", name: "Value" } },
      snapshot: '- button "Old Search" [ref=e1]\\n- textbox "Value" [ref=e2]'
    } : { value: "recycled", clicked: command[1] }
  }))));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				assert.equal(snapshot.isError, false);

				const staleBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["open", "https://second.example/"],
						["click", "@e1"],
					]),
				});
				const staleBatchDetails = readRecord(staleBatch.details);
				assert.equal(staleBatch.isError, true);
				assert.equal(staleBatchDetails.failureCategory, "stale-ref");
				assert.match(
					readString(readRecord(staleBatch.content[0]).text),
					/after an earlier batch step can navigate or mutate/,
				);

				const staleScrollAliasBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["open", "https://second.example/"],
						["scrollinto", "@e1"],
					]),
				});
				const staleScrollAliasBatchDetails = readRecord(staleScrollAliasBatch.details);
				assert.equal(staleScrollAliasBatch.isError, true);
				assert.equal(staleScrollAliasBatchDetails.failureCategory, "stale-ref");
				assert.match(
					readString(readRecord(staleScrollAliasBatch.content[0]).text),
					/Batch step scrollinto uses page-scoped ref @e1/,
				);

				const staleTapBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["open", "https://second.example/"],
						["tap", "@e1"],
					]),
				});
				const staleTapBatchDetails = readRecord(staleTapBatch.details);
				assert.equal(staleTapBatch.isError, true);
				assert.equal(staleTapBatchDetails.failureCategory, "stale-ref");
				assert.match(
					readString(readRecord(staleTapBatch.content[0]).text),
					/Batch step tap uses page-scoped ref @e1/,
				);

				const staleKeydownBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["keydown", "Enter"],
						["click", "@e1"],
					]),
				});
				const staleKeydownBatchDetails = readRecord(staleKeydownBatch.details);
				assert.equal(staleKeydownBatch.isError, true);
				assert.equal(staleKeydownBatchDetails.failureCategory, "stale-ref");
				assert.match(
					readString(readRecord(staleKeydownBatch.content[0]).text),
					/Batch step click uses page-scoped ref @e1/,
				);

				const staleScrollThenClickBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["scroll", "down"],
						["click", "@e1"],
					]),
				});
				const staleScrollThenClickBatchDetails = readRecord(staleScrollThenClickBatch.details);
				assert.equal(staleScrollThenClickBatch.isError, true);
				assert.equal(staleScrollThenClickBatchDetails.failureCategory, "stale-ref");
				assert.match(
					readString(readRecord(staleScrollThenClickBatch.content[0]).text),
					/Batch step click uses page-scoped ref @e1/,
				);

				const staleScrollIntoThenClickBatch = await executeRegisteredTool(
					harness.tool,
					harness.ctx,
					{
						args: ["batch"],
						stdin: JSON.stringify([
							["scrollintoview", "@e1"],
							["click", "@e2"],
						]),
					},
				);
				const staleScrollIntoThenClickBatchDetails = readRecord(
					staleScrollIntoThenClickBatch.details,
				);
				assert.equal(staleScrollIntoThenClickBatch.isError, true);
				assert.equal(staleScrollIntoThenClickBatchDetails.failureCategory, "stale-ref");
				assert.match(
					readString(readRecord(staleScrollIntoThenClickBatch.content[0]).text),
					/Batch step click uses page-scoped ref @e2/,
				);

				const snapshotThenClickThenRead = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["snapshot", "-i"],
						["click", "@e1"],
						["get", "value", "@e2"],
					]),
				});
				assert.equal(snapshotThenClickThenRead.isError, true);
				assert.equal(snapshotThenClickThenRead.details?.failureCategory, "stale-ref");
				assert.match(
					readString(snapshotThenClickThenRead.content[0].text),
					/Batch step get uses page-scoped ref @e2 after an earlier batch step/,
				);
				const rawSnapshotThenClickThenRead = await executeRegisteredTool(
					harness.tool,
					harness.ctx,
					{ args: ["batch", "snapshot -i", "click @e1", "get value @e2"] },
				);
				assert.equal(rawSnapshotThenClickThenRead.isError, true);
				assert.equal(rawSnapshotThenClickThenRead.details?.failureCategory, "stale-ref");
				assert.match(
					readString(rawSnapshotThenClickThenRead.content[0].text),
					/Batch step get uses page-scoped ref @e2 after an earlier batch step/,
				);

				const windowThenRead = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["window", "new"],
						["get", "value", "@e1"],
					]),
				});
				assert.equal(windowThenRead.isError, true);
				assert.equal(windowThenRead.details?.failureCategory, "stale-ref");
				assert.match(
					readString(windowThenRead.content[0].text),
					/Batch step get uses page-scoped ref @e1 after an earlier batch step/,
				);
				const diffThenRead = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["diff", "url", "https://first.example/", "https://second.example/"],
						["get", "value", "@e1"],
					]),
				});
				assert.equal(diffThenRead.isError, true);
				assert.equal(diffThenRead.details?.failureCategory, "stale-ref");
				assert.match(
					readString(diffThenRead.content[0].text),
					/Batch step get uses page-scoped ref @e1 after an earlier batch step/,
				);

				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.filter((entry) => entry.args.includes("batch")).length, 0);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension keeps pending WebMCP targets unknown and trusts a later batch snapshot",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-webmcp-page-state-"));
		const logPath = join(tempDir, "invocations.log");
		const pageStatePath = join(tempDir, "after-webmcp");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("batch")) {
  fs.writeFileSync(${JSON.stringify(pageStatePath)}, "after");
  const detached = args.some((arg) => arg.includes("--detach"));
  process.stdout.write(JSON.stringify({ success: true, data: detached ? [
    { command: ["webmcp", "invoke", "wait_for_navigation", "--detach"], success: true, result: { invocationId: "invocation-2", status: "pending" } },
    { command: ["get", "url"], success: true, result: { result: "https://webmcp.example/after", url: "https://webmcp.example/after" } },
    { command: ["snapshot", "-i"], success: true, result: {
      origin: "https://webmcp.example/after",
      url: "https://webmcp.example/after",
      refs: { e1: { role: "button", name: "Continue" } },
      snapshot: '- button "Continue" [ref=e1]'
    } }
  ] : [
    { command: ["webmcp", "invoke", "set_message"], success: true, result: { status: "completed" } },
    { command: ["get", "url"], success: true, result: { result: "https://webmcp.example/after", url: "https://webmcp.example/after" } },
    { command: ["snapshot", "-i"], success: true, result: {
      origin: "https://webmcp.example/after",
      title: "After WebMCP",
      url: "https://webmcp.example/after",
      refs: { e1: { role: "button", name: "Continue" } },
      snapshot: '- button "Continue" [ref=e1]'
    } }
  ] }));
} else if (args.includes("webmcp") && args.includes("cancel")) {
  process.stdout.write(JSON.stringify({ success: false, error: "webmcp_cancel_failed: Invocation could not be canceled" }));
} else if (args.includes("webmcp") && args.includes("invoke")) {
  process.stdout.write(JSON.stringify({ success: true, data: { invocationId: "invocation-1", status: "pending" } }));
} else if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "WebMCP", url: "https://webmcp.example/start" } }));
} else if (args.includes("get") && args.includes("url")) {
  const url = fs.existsSync(${JSON.stringify(pageStatePath)}) ? "https://webmcp.example/after" : "https://webmcp.example/start";
  process.stdout.write(JSON.stringify({ success: true, data: { result: url, url } }));
} else if (args.includes("get") && args.includes("title")) {
  const title = fs.existsSync(${JSON.stringify(pageStatePath)}) ? "After WebMCP" : "WebMCP";
  process.stdout.write(JSON.stringify({ success: true, data: { result: title, title } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: true } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://webmcp.example/start"],
				});
				assert.equal(opened.isError, false, JSON.stringify(opened));

				const pending = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["webmcp", "invoke", "wait_for_navigation", "--detach"],
				});
				const pendingDetails = readRecord(pending.details);
				assert.equal(pending.isError, false, JSON.stringify(pending));
				assert.equal(readRecord(pendingDetails.data ?? {}).status, "pending");
				assert.equal(pendingDetails.sessionTabTarget, undefined);
				assert.equal(pendingDetails.sessionTabTargetUnknown, true);
				assert.equal(
					readRecord(pendingDetails.refSnapshotInvalidation ?? {}).reason,
					"page-transition",
				);
				assert.deepEqual(
					readArray(pendingDetails.nextActions ?? [])
						.map((value) => readRecord(value))
						.map((action) => action.id),
					["verify-page-target-after-pending-webmcp"],
				);

				const invocationCount = (await readInvocationLog(logPath)).length;
				const blockedSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				assert.equal(blockedSnapshot.isError, true, JSON.stringify(blockedSnapshot));
				assert.match(
					readString(blockedSnapshot.content[0].text ?? ""),
					/active page became unverified/,
				);
				assert.equal((await readInvocationLog(logPath)).length, invocationCount);

				const verifiedUrl = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "url"],
				});
				const verifiedUrlDetails = readRecord(verifiedUrl.details);
				assert.equal(verifiedUrl.isError, false, JSON.stringify(verifiedUrl));
				assert.deepEqual(verifiedUrlDetails.sessionTabTarget, {
					title: undefined,
					url: "https://webmcp.example/start",
				});

				const batchSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch", "--bail"],
					stdin: JSON.stringify([
						["webmcp", "invoke", "set_message"],
						["get", "url"],
						["snapshot", "-i"],
					]),
				});
				const batchSnapshotDetails = readRecord(batchSnapshot.details);
				assert.equal(batchSnapshot.isError, false, JSON.stringify(batchSnapshot));
				assert.equal(batchSnapshotDetails.sessionTabTargetUnknown, undefined);
				assert.deepEqual(batchSnapshotDetails.sessionTabTarget, {
					title: "After WebMCP",
					url: "https://webmcp.example/after",
				});
				assert.deepEqual(readRecord(batchSnapshotDetails.refSnapshot ?? {}).refIds, ["e1"]);

				const freshClick = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				assert.equal(freshClick.isError, false, JSON.stringify(freshClick));

				const pendingBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [
						"batch",
						"--bail",
						"webmcp invoke wait_for_navigation --detach",
						"get url",
						"snapshot -i",
					],
				});
				const pendingBatchDetails = readRecord(pendingBatch.details);
				assert.equal(pendingBatch.isError, false, JSON.stringify(pendingBatch));
				assert.equal(pendingBatchDetails.sessionTabTarget, undefined);
				assert.equal(pendingBatchDetails.sessionTabTargetUnknown, true);
				assert.equal(pendingBatchDetails.refSnapshot, undefined);
				assert.doesNotMatch(
					JSON.stringify(pendingBatchDetails.batchSteps),
					/inspect-after-mutation/,
				);

				const failedCancel = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["webmcp", "cancel", "invocation-2"],
				});
				const failedCancelDetails = readRecord(failedCancel.details);
				assert.equal(failedCancel.isError, true, JSON.stringify(failedCancel));
				assert.equal(failedCancelDetails.sessionTabTarget, undefined);
				assert.equal(failedCancelDetails.sessionTabTargetUnknown, true);
				assert.equal(
					readRecord(failedCancelDetails.refSnapshotInvalidation ?? {}).reason,
					"page-transition",
				);
				const failedCancelInvocationCount = (await readInvocationLog(logPath)).length;
				const blockedAfterFailedCancel = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				assert.equal(
					blockedAfterFailedCancel.isError,
					true,
					JSON.stringify(blockedAfterFailedCancel),
				);
				assert.equal((await readInvocationLog(logPath)).length, failedCancelInvocationCount);

				const reverifiedPendingBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["get", "url"],
				});
				assert.equal(reverifiedPendingBatch.isError, false, JSON.stringify(reverifiedPendingBatch));
				const postVerificationInvocationCount = (await readInvocationLog(logPath)).length;
				const invalidatedClick = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				const invalidatedClickDetails = readRecord(invalidatedClick.details);
				assert.equal(invalidatedClick.isError, true, JSON.stringify(invalidatedClick));
				assert.equal(invalidatedClickDetails.failureCategory, "stale-ref");
				assert.equal((await readInvocationLog(logPath)).length, postVerificationInvocationCount);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension conservatively invalidates direct and batched refs on recording starts and URL restarts",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-record-start-refs-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
// Mirror upstream restart finalizing the previous recording so its mtime stays inside the
// wrapper's artifact freshness window regardless of suite timing.
const refreshRecordings = () => {
  for (const entry of fs.readdirSync(${JSON.stringify(tempDir)})) {
    if (entry.endsWith(".webm")) fs.writeFileSync(require("node:path").join(${JSON.stringify(tempDir)}, entry), "webm");
  }
};
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://record.example/",
    title: "Record fixture",
    url: "https://record.example/",
    refs: { e1: { role: "link", name: "Old target" } },
    snapshot: '- link "Old target" [ref=e1]'
  } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://record.example/" } }));
} else if (args.includes("record") && args.includes("start")) {
  if (args.some((arg) => arg.includes("already-active"))) {
    process.stdout.write(JSON.stringify({ success: false, error: "Recording already active" }));
  } else {
    const startPath = args[args.indexOf("start") + 1];
    fs.writeFileSync(startPath, "webm");
    process.stdout.write(JSON.stringify({ success: true, data: { path: startPath } }));
  }
} else if (args.includes("batch")) {
  const raw = args.slice(args.indexOf("batch") + 1).filter(arg => arg !== "--bail");
  const steps = raw.length ? raw.map(row => row.split(" ")) : JSON.parse(stdin);
  process.stdout.write(JSON.stringify({ success: true, data: steps.map(command => {
    if (command[0] === "record") {
      refreshRecordings();
      fs.writeFileSync(command[2], "webm");
      return { command, success: true, data: { restarted: true, path: command[2] } };
    }
    return { command, success: true, data: command[0] === "click" ? { clicked: command[1] } : {} };
  }) }));
} else if (args.includes("record") && args.includes("restart")) {
  const restartPath = args[args.indexOf("restart") + 1];
  refreshRecordings();
  fs.writeFileSync(restartPath, "webm");
  process.stdout.write(JSON.stringify({ success: true, data: { restarted: true, path: restartPath } }));
} else if (args.includes("diff")) {
  process.stdout.write(JSON.stringify({ success: true, data: { match: true } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: args.at(-1) } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const initialSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				const initialSnapshotDetails = readRecord(initialSnapshot.details);
				assert.equal(initialSnapshot.isError, false, JSON.stringify(initialSnapshot));
				assert.deepEqual(readRecord(initialSnapshotDetails.refSnapshot ?? {}).refIds, ["e1"]);

				const staleBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["record", "start", join(tempDir, "batch.webm")],
						["click", "@e1"],
					]),
				});
				const staleBatchDetails = readRecord(staleBatch.details);
				assert.equal(staleBatch.isError, true, JSON.stringify(staleBatch));
				assert.equal(staleBatchDetails.failureCategory, "stale-ref", JSON.stringify(staleBatch));
				assert.match(
					readString(staleBatch.content[0].text ?? ""),
					/after an earlier batch step can navigate or mutate/,
				);

				const recordStart = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "start", join(tempDir, "direct.webm")],
				});
				const recordStartDetails = readRecord(recordStart.details);
				assert.equal(recordStart.isError, false, JSON.stringify(recordStart));
				assert.equal(
					readRecord(recordStartDetails.refSnapshotInvalidation ?? {}).reason,
					"page-transition",
				);
				assert.equal(recordStartDetails.refSnapshot, undefined);
				assert.equal(
					readRecord(recordStartDetails.sessionTabTarget).url,
					"https://record.example/",
				);
				assert.match(
					readString(readRecord(recordStartDetails.refSnapshotInvalidation).summary),
					/this is not evidence of a page change/,
				);

				const staleClick = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				const staleClickDetails = readRecord(staleClick.details);
				assert.equal(staleClick.isError, true, JSON.stringify(staleClick));
				assert.equal(staleClickDetails.failureCategory, "stale-ref", JSON.stringify(staleClick));
				assert.match(
					readString(staleClick.content[0].text ?? ""),
					/cannot be used yet\..*conservatively invalidate/,
				);

				const staleGuardedRead = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["is", "visible", "@e1"],
				});
				const staleGuardedReadDetails = readRecord(staleGuardedRead.details);
				assert.equal(staleGuardedRead.isError, true, JSON.stringify(staleGuardedRead));
				assert.equal(
					staleGuardedReadDetails.failureCategory,
					"stale-ref",
					JSON.stringify(staleGuardedRead),
				);

				const staleScreenshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["screenshot", "@e1", join(tempDir, "stale.png")],
				});
				const staleScreenshotDetails = readRecord(staleScreenshot.details);
				assert.equal(staleScreenshot.isError, true, JSON.stringify(staleScreenshot));
				assert.equal(
					staleScreenshotDetails.failureCategory,
					"stale-ref",
					JSON.stringify(staleScreenshot),
				);

				const freshSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				const freshSnapshotDetails = readRecord(freshSnapshot.details);
				assert.equal(freshSnapshot.isError, false, JSON.stringify(freshSnapshot));
				assert.equal(freshSnapshotDetails.refSnapshotInvalidation, undefined);
				assert.deepEqual(readRecord(freshSnapshotDetails.refSnapshot ?? {}).refIds, ["e1"]);

				const plainRestartBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["record", "restart", join(tempDir, "plain.webm")],
						["click", "@e1"],
					]),
				});
				const plainRestartBatchDetails = readRecord(plainRestartBatch.details);
				assert.equal(plainRestartBatch.isError, false, JSON.stringify(plainRestartBatch));
				assert.equal(plainRestartBatchDetails.refSnapshotInvalidation, undefined);

				const plainRestartClick = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				assert.equal(plainRestartClick.isError, false, JSON.stringify(plainRestartClick));

				const navigatingRestart = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "restart", join(tempDir, "nav.webm"), "https://record.example/next"],
				});
				const navigatingRestartDetails = readRecord(navigatingRestart.details);
				assert.equal(navigatingRestart.isError, false, JSON.stringify(navigatingRestart));
				assert.equal(
					readRecord(navigatingRestartDetails.refSnapshotInvalidation ?? {}).reason,
					"page-transition",
				);

				const staleAfterRestart = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				const staleAfterRestartDetails = readRecord(staleAfterRestart.details);
				assert.equal(staleAfterRestart.isError, true, JSON.stringify(staleAfterRestart));
				assert.equal(
					staleAfterRestartDetails.failureCategory,
					"stale-ref",
					JSON.stringify(staleAfterRestart),
				);

				const recoverySnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				assert.equal(recoverySnapshot.isError, false, JSON.stringify(recoverySnapshot));

				const failedStart = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["record", "start", join(tempDir, "already-active.webm")],
				});
				const failedStartDetails = readRecord(failedStart.details);
				assert.equal(failedStart.isError, true, JSON.stringify(failedStart));
				assert.equal(
					readRecord(failedStartDetails.refSnapshotInvalidation ?? {}).reason,
					"page-transition",
				);

				const staleAfterFailedStart = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				const staleAfterFailedStartDetails = readRecord(staleAfterFailedStart.details);
				assert.equal(staleAfterFailedStart.isError, true, JSON.stringify(staleAfterFailedStart));
				assert.equal(
					staleAfterFailedStartDetails.failureCategory,
					"stale-ref",
					JSON.stringify(staleAfterFailedStart),
				);

				// Boolean flags do not consume the following token, so a ref after them is a positional
				// selector that upstream resolves; the guard must keep rejecting these while invalidated.
				const booleanFlagClick = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "--new-tab", "@e1"],
				});
				const booleanFlagClickDetails = readRecord(booleanFlagClick.details);
				assert.equal(booleanFlagClick.isError, true, JSON.stringify(booleanFlagClick));
				assert.equal(
					booleanFlagClickDetails.failureCategory,
					"stale-ref",
					JSON.stringify(booleanFlagClick),
				);
				const booleanFlagScreenshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["screenshot", "--full", "@e1", join(tempDir, "full.png")],
				});
				const booleanFlagScreenshotDetails = readRecord(booleanFlagScreenshot.details);
				assert.equal(booleanFlagScreenshot.isError, true, JSON.stringify(booleanFlagScreenshot));
				assert.equal(
					booleanFlagScreenshotDetails.failureCategory,
					"stale-ref",
					JSON.stringify(booleanFlagScreenshot),
				);
				const booleanFlagBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["record", "start", join(tempDir, "latch.webm")],
						["click", "--new-tab", "@e1"],
					]),
				});
				const booleanFlagBatchDetails = readRecord(booleanFlagBatch.details);
				assert.equal(booleanFlagBatch.isError, true, JSON.stringify(booleanFlagBatch));
				assert.equal(
					booleanFlagBatchDetails.failureCategory,
					"stale-ref",
					JSON.stringify(booleanFlagBatch),
				);

				// Upstream treats these @e-looking operands as literal text, fill content, or paths, so the
				// stale-ref guard must not reject them even while the snapshot state is invalidated.
				const literalWaitText = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["wait", "--text", "@e1"],
				});
				assert.equal(literalWaitText.isError, false, JSON.stringify(literalWaitText));
				const literalFindText = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["find", "text", "@e1", "click"],
				});
				assert.equal(literalFindText.isError, false, JSON.stringify(literalFindText));
				const literalBaselinePath = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["diff", "screenshot", "--baseline", "@e1.png"],
				});
				assert.equal(literalBaselinePath.isError, false, JSON.stringify(literalBaselinePath));
				const guardedDiffSelector = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: [
						"diff",
						"screenshot",
						"--baseline",
						join(tempDir, "baseline.png"),
						"--selector",
						"@e1",
					],
				});
				const guardedDiffSelectorDetails = readRecord(guardedDiffSelector.details);
				assert.equal(guardedDiffSelector.isError, true, JSON.stringify(guardedDiffSelector));
				assert.equal(
					guardedDiffSelectorDetails.failureCategory,
					"stale-ref",
					JSON.stringify(guardedDiffSelector),
				);

				// Raw argument-mode batch steps are what upstream executes, so the stale-ref
				// preflight must scan them exactly like stdin steps.
				const rawArgvBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch", "click @e1"],
				});
				const rawArgvBatchDetails = readRecord(rawArgvBatch.details);
				assert.equal(rawArgvBatch.isError, true, JSON.stringify(rawArgvBatch));
				assert.equal(
					rawArgvBatchDetails.failureCategory,
					"stale-ref",
					JSON.stringify(rawArgvBatch),
				);
				const rawArgvBooleanFlagBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch", "click --new-tab @e1"],
				});
				const rawArgvBooleanFlagBatchDetails = readRecord(rawArgvBooleanFlagBatch.details);
				assert.equal(
					rawArgvBooleanFlagBatch.isError,
					true,
					JSON.stringify(rawArgvBooleanFlagBatch),
				);
				assert.equal(
					rawArgvBooleanFlagBatchDetails.failureCategory,
					"stale-ref",
					JSON.stringify(rawArgvBooleanFlagBatch),
				);
				// Upstream ignores stdin whenever raw batch arguments exist, so stdin refs
				// must not be falsely rejected in that shape.
				const rawArgvIgnoredStdin = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch", "wait 100"],
					stdin: JSON.stringify([["click", "@e1"]]),
				});
				assert.equal(rawArgvIgnoredStdin.isError, false, JSON.stringify(rawArgvIgnoredStdin));
				assert.deepEqual(
					readArray(rawArgvIgnoredStdin.details?.batchSteps).map((row) => readRecord(row).command),
					[["wait", "100"]],
				);

				const latchRecoverySnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				assert.equal(latchRecoverySnapshot.isError, false, JSON.stringify(latchRecoverySnapshot));
				const rawArgvLatch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch", `record start ${join(tempDir, "latch2.webm")}`, "click @e1"],
				});
				const rawArgvLatchDetails = readRecord(rawArgvLatch.details);
				assert.equal(rawArgvLatch.isError, true, JSON.stringify(rawArgvLatch));
				assert.equal(
					rawArgvLatchDetails.failureCategory,
					"stale-ref",
					JSON.stringify(rawArgvLatch),
				);
				assert.match(
					readString(rawArgvLatch.content[0].text ?? ""),
					/after an earlier batch step can navigate or mutate/,
				);

				const invocations = await readInvocationLog(logPath);
				const batches = invocations.filter((entry) => entry.args.includes("batch"));
				assert.equal(batches.length, 2);
				assert.deepEqual(batches[1].args.slice(-2), ["batch", "wait 100"]);
				assert.equal(batches[1].stdin, JSON.stringify([["click", "@e1"]]));
				assert.equal(
					invocations.filter(
						(entry) => entry.args.includes("click") && !entry.args.includes("find"),
					).length,
					1,
				);
				assert.equal(invocations.filter((entry) => entry.args.includes("is")).length, 0);
				assert.equal(
					invocations.filter(
						(entry) => entry.args.includes("screenshot") && !entry.args.includes("diff"),
					).length,
					0,
				);
				assert.equal(invocations.filter((entry) => entry.args.includes("wait")).length, 1);
				assert.equal(invocations.filter((entry) => entry.args.includes("find")).length, 1);
				assert.equal(invocations.filter((entry) => entry.args.includes("diff")).length, 1);
				assert.equal(
					invocations.filter(
						(entry) => entry.args.includes("record") && entry.args.includes("start"),
					).length,
					2,
				);
				assert.equal(
					invocations.filter(
						(entry) => entry.args.includes("record") && entry.args.includes("restart"),
					).length,
					1,
				);
				assert.ok(invocations.filter((entry) => entry.args.includes("snapshot")).length >= 4);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension invalidates refs when a batch recording start times out before returning rows",
	{ concurrency: false },
	async (t) => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-record-batch-timeout-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		const startPath = join(tempDir, "batch-started");
		const realSetTimeout = setTimeout;
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://record.example/",
    title: "Record fixture",
    url: "https://record.example/",
    refs: { e1: { role: "link", name: "Old target" } },
    snapshot: '- link "Old target" [ref=e1]'
  } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://record.example/" } }));
} else if (args.includes("batch")) {
  fs.writeFileSync(${JSON.stringify(startPath)}, "started");
  // Simulate upstream buffering batch rows past the wrapper timeout.
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ success: true, data: [] }));
    process.exit(0);
  }, 4000);
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const timeoutBatch = async (args: readonly string[], stdin: string) => {
					await rm(startPath, { force: true });
					const started = Promise.withResolvers<boolean>();
					const watcher = watch(tempDir, (_event, filename) => {
						if (filename === "batch-started" && existsSync(startPath)) {
							started.resolve(true);
						}
					});
					const startupTimer = realSetTimeout(
						() => started.reject(new Error("batch child did not start")),
						15_000,
					);
					t.after(() => {
						clearTimeout(startupTimer);
						watcher.close();
					});
					const controller = new AbortController();
					const nativeSpawn = childProcess.spawn;
					t.mock.method(
						childProcess,
						"spawn",
						(...spawnArgs: Readonly<Parameters<typeof childProcess.spawn>>) => {
							if (Array.isArray(spawnArgs[1]) && spawnArgs[1].includes("batch")) {
								t.mock.timers.enable({ apis: ["setTimeout"] });
							}
							return nativeSpawn(...spawnArgs);
						},
					);
					syncBuiltinESMExports();
					const pending = executeRegisteredTool(
						harness.tool,
						harness.ctx,
						{ args, stdin, timeoutMs: 900 },
						controller.signal,
					);
					try {
						await started.promise;
						// The native child is now running; advance only its wrapper watchdog.
						t.mock.timers.tick(900);
						t.mock.timers.reset();
						const result = await pending;
						assert.equal(result.details?.agentBrowserStarted, true);
						return result;
					} finally {
						t.mock.timers.reset();
						t.mock.restoreAll();
						syncBuiltinESMExports();
						clearTimeout(startupTimer);
						watcher.close();
						controller.abort();
						await Promise.allSettled([pending]);
					}
				};
				const initialSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				const initialSnapshotDetails = readRecord(initialSnapshot.details);
				assert.equal(initialSnapshot.isError, false, JSON.stringify(initialSnapshot));
				assert.deepEqual(readRecord(initialSnapshotDetails.refSnapshot ?? {}).refIds, ["e1"]);

				const timedOutBatch = await timeoutBatch(
					["batch"],
					JSON.stringify([
						["record", "start", join(tempDir, "swap.webm")],
						["wait", "3000"],
					]),
				);
				const timedOutBatchDetails = readRecord(timedOutBatch.details);
				assert.equal(timedOutBatch.isError, true, JSON.stringify(timedOutBatch));
				assert.equal(timedOutBatchDetails.timedOut, true, JSON.stringify(timedOutBatch));
				assert.equal(
					readRecord(timedOutBatchDetails.refSnapshotInvalidation ?? {}).reason,
					"page-transition",
					JSON.stringify(timedOutBatch),
				);

				const staleClick = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				const staleClickDetails = readRecord(staleClick.details);
				assert.equal(staleClick.isError, true, JSON.stringify(staleClick));
				assert.equal(staleClickDetails.failureCategory, "stale-ref", JSON.stringify(staleClick));

				const freshSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				const freshSnapshotDetails = readRecord(freshSnapshot.details);
				assert.equal(freshSnapshot.isError, false, JSON.stringify(freshSnapshot));
				assert.deepEqual(readRecord(freshSnapshotDetails.refSnapshot ?? {}).refIds, ["e1"]);

				// Upstream uses raw batch arguments exclusively when any exist, so a stdin-only record step
				// cannot execute and must not invalidate refs when such a batch times out.
				const argvExclusiveTimeout = await timeoutBatch(
					["batch", "wait 500"],
					JSON.stringify([["record", "start", join(tempDir, "ignored.webm")]]),
				);
				const argvExclusiveTimeoutDetails = readRecord(argvExclusiveTimeout.details);
				assert.equal(argvExclusiveTimeout.isError, true, JSON.stringify(argvExclusiveTimeout));
				assert.equal(
					argvExclusiveTimeoutDetails.timedOut,
					true,
					JSON.stringify(argvExclusiveTimeout),
				);
				assert.equal(
					argvExclusiveTimeoutDetails.refSnapshotInvalidation,
					undefined,
					JSON.stringify(argvExclusiveTimeoutDetails.refSnapshotInvalidation),
				);

				const clickAfterArgvTimeout = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				assert.equal(clickAfterArgvTimeout.isError, false, JSON.stringify(clickAfterArgvTimeout));

				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 1);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension allows same-snapshot form control batches before a hard invalidating click",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ref-batch-form-controls-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://form.example/",
    refs: {
      e1: { role: "checkbox", name: "Email alerts" },
      e2: { role: "checkbox", name: "SMS alerts" },
      e3: { role: "radio", name: "Daily" },
      e4: { role: "combobox", name: "Plan" },
      e5: { role: "button", name: "Submit" },
      e6: { role: "textbox", name: "Name" },
      e7: { role: "textbox", name: "Email" }
    },
    snapshot: '- checkbox "Email alerts" [ref=e1]\\n- checkbox "SMS alerts" [ref=e2]\\n- radio "Daily" [ref=e3]\\n- combobox "Plan" [ref=e4]\\n- button "Submit" [ref=e5]\\n- textbox "Name" [ref=e6]\\n- textbox "Email" [ref=e7]'
  } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://form.example/" } }));
} else if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  process.stdout.write(JSON.stringify(steps.map((step) => ({ command: step, success: true, result: { ok: step[0] } }))));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				assert.equal(snapshot.isError, false, JSON.stringify(snapshot));

				const formControlsBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["check", "@e1"],
						["uncheck", "@e1"],
						["check", "@e2"],
						["check", "@e3"],
						["select", "@e4", "Pro"],
						["fill", "@e6", "Alice"],
						["fill", "@e7", "alice@example.com"],
						["click", "@e5"],
					]),
				});
				assert.equal(formControlsBatch.isError, false, JSON.stringify(formControlsBatch));

				const clickCheckboxThenFill = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["click", "@e1"],
						["fill", "@e6", "Alice"],
					]),
				});
				assert.equal(clickCheckboxThenFill.isError, false, JSON.stringify(clickCheckboxThenFill));

				const clickSubmitThenFill = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["click", "@e5"],
						["fill", "@e6", "Alice"],
					]),
				});
				const clickSubmitThenFillDetails = readRecord(clickSubmitThenFill.details);
				assert.equal(clickSubmitThenFill.isError, true);
				assert.equal(clickSubmitThenFillDetails.failureCategory, "stale-ref");
				assert.match(
					readString(readRecord(clickSubmitThenFill.content[0]).text),
					/after an earlier batch step can navigate or mutate/,
				);

				const wrongRoleThenFill = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["check", "@e6"],
						["fill", "@e6", "Alice"],
					]),
				});
				const wrongRoleThenFillDetails = readRecord(wrongRoleThenFill.details);
				assert.equal(wrongRoleThenFill.isError, true);
				assert.equal(wrongRoleThenFillDetails.failureCategory, "stale-ref");
				assert.match(
					readString(readRecord(wrongRoleThenFill.content[0]).text),
					/Batch step fill uses page-scoped ref @e6/,
				);

				const invocations = await readInvocationLog(logPath);
				const batchInvocations = invocations.filter((entry) => entry.args.includes("batch"));
				assert.equal(batchInvocations.length, 2);
				assert.deepEqual(readArray(JSON.parse(batchInvocations[0]?.stdin ?? "[]")), [
					["check", "@e1"],
					["uncheck", "@e1"],
					["check", "@e2"],
					["check", "@e3"],
					["select", "@e4", "Pro"],
					["fill", "@e6", "Alice"],
					["fill", "@e7", "alice@example.com"],
					["click", "@e5"],
				]);
				assert.deepEqual(readArray(JSON.parse(batchInvocations[1]?.stdin ?? "[]")), [
					["click", "@e1"],
					["fill", "@e6", "Alice"],
				]);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension allows batch stdin ref steps after snapshot following an invalidating step",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ref-batch-snapshot-reset-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const navigated = ${JSON.stringify(join(tempDir, "navigated"))};
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("batch")) {
  fs.writeFileSync(navigated, "yes");
  process.stdout.write(JSON.stringify([
    { command: ["open", "https://second.example/"], success: true, result: { title: "Second", url: "https://second.example/" } },
    { command: ["snapshot", "-i"], success: true, result: {
      origin: "https://second.example/",
      refs: { e7: { role: "button", name: "Go" } },
      snapshot: '- button "Go" [ref=e7]'
    } },
    { command: ["click", "@e7"], success: true, result: { clicked: "ok" } }
  ]));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: fs.existsSync(navigated) ? "https://second.example/" : "https://first.example/" } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "batched ref" } }));
} else if (args.includes("snapshot")) {
  const onSecond = fs.existsSync(navigated);
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: onSecond ? "https://second.example/" : "https://first.example/",
    refs: onSecond ? { e7: { role: "button", name: "Go" } } : { e1: { role: "button", name: "Old" } },
    snapshot: onSecond ? '- button "Go" [ref=e7]' : '- button "Old" [ref=e1]'
  } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				assert.equal(snapshot.isError, false);

				const batch = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						["open", "https://second.example/"],
						["snapshot", "-i"],
						["click", "@e7"],
					]),
				});
				assert.equal(batch.isError, false);
				assert.deepEqual(readRecord(batch.details?.refSnapshot).refIds, ["e7"]);
				const click = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e7"],
				});
				assert.equal(click.isError, false, JSON.stringify(click));
				assert.equal(readRecord(click.details?.data).clicked, "batched ref");

				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.filter((entry) => entry.args.includes("batch")).length, 1);
				assert.equal(invocations.filter((entry) => entry.args.includes("click")).length, 1);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension rejects batched getter refs after same-page rerender changes current snapshot identity",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ref-rerender-"));
		const logPath = join(tempDir, "invocations.log");
		const statePath = join(tempDir, "state.json");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null }) + "\\n");
const statePath = ${JSON.stringify(statePath)};
let count = 0;
try { count = JSON.parse(fs.readFileSync(statePath, "utf8")).snapshots || 0; } catch {}
if (args.includes("snapshot")) {
  count += 1;
  fs.writeFileSync(statePath, JSON.stringify({ snapshots: count }));
  const name = count === 1 ? "Old target before rerender" : "New target after rerender";
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://same.example/fixture",
    refs: { e1: { role: "button", name } },
    snapshot: '- button "' + name + '" [ref=e1]'
  } }));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "unexpected" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: "ok" }));
}`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_PAGE_URL: "https://same.example/fixture",
					AGENT_BROWSER_IDLE_TIMEOUT_MS: "1234",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					assert.equal(snapshot.isError, false);

					const staleBatch = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch"],
						stdin: JSON.stringify([
							["get", "text", "@e1"],
							["get", "html", "@e1"],
						]),
					});
					const staleBatchDetails = readRecord(staleBatch.details);
					assert.equal(staleBatch.isError, true);
					assert.equal(staleBatchDetails.failureCategory, "stale-ref");
					assert.match(
						readString(readRecord(staleBatch.content[0]).text),
						/no longer matches the latest same-page snapshot/,
					);
					assert.match(
						readString(readRecord(staleBatch.content[0]).text),
						/Old target before rerender/,
					);
					assert.match(
						readString(readRecord(staleBatch.content[0]).text),
						/New target after rerender/,
					);

					const invocations = await readInvocationLog(logPath);
					assert.equal(invocations.filter((entry) => entry.args.includes("batch")).length, 0);
					assert.equal(invocations.filter((entry) => entry.args.includes("snapshot")).length, 2);
					assert.deepEqual(
						invocations.map((entry) => entry.idleTimeout),
						["1234", "1234", "1234"],
					);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension keeps upstream-ignored batch stdin out of artifact and screenshot preflights",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-ignored-stdin-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: "https://record.example/",
    title: "Record fixture",
    url: "https://record.example/",
    refs: { e1: { role: "link", name: "Old target" } },
    snapshot: '- link "Old target" [ref=e1]'
  } }));
} else if (args.includes("record") && args.includes("start")) {
  const startPath = args[args.indexOf("start") + 1];
  fs.writeFileSync(startPath, "webm");
  process.stdout.write(JSON.stringify({ success: true, data: { path: startPath } }));
} else if (args.includes("batch")) {
  process.stdout.write(JSON.stringify([
    { command: ["wait", "10"], success: true, data: {} }
  ]));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: {} }));
}`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_PAGE_URL: "https://record.example/",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);

					const initialSnapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					assert.equal(initialSnapshot.isError, false, JSON.stringify(initialSnapshot));
					const recordStart = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["record", "start", join(tempDir, "swap.webm")],
					});
					assert.equal(recordStart.isError, false, JSON.stringify(recordStart));

					// Upstream keeps --bail=true as a raw command (unknown-command row) and ignores
					// stdin, so the guard must not scan the ignored stdin refs.
					const bailEquals = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch", "--bail=true"],
						stdin: JSON.stringify([["click", "@e1"]]),
					});
					const bailEqualsDetails = readRecord(bailEquals.details);
					assert.notEqual(
						bailEqualsDetails.failureCategory,
						"stale-ref",
						JSON.stringify(bailEquals),
					);
					assert.equal(
						(await readInvocationLog(logPath)).filter((entry) => entry.args.includes("batch"))
							.length,
						0,
					);
					assert.match(readString(bailEquals.content[0].text ?? ""), /Use exact batch --bail/);

					// Malformed ignored stdin must not fail artifact preflight for a valid raw-argv call.
					const malformedIgnoredStdin = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch", "wait 10"],
						stdin: "not json",
					});
					assert.equal(malformedIgnoredStdin.isError, false, JSON.stringify(malformedIgnoredStdin));

					// A close-then-record sequence in ignored stdin must not trigger the batch
					// close/record preflight rejection.
					const ignoredCloseRecord = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch", "wait 10"],
						stdin: JSON.stringify([["close"], ["record", "start", join(tempDir, "never.webm")]]),
					});
					assert.equal(ignoredCloseRecord.isError, false, JSON.stringify(ignoredCloseRecord));

					// Ignored stdin screenshot rows must not create host parent directories.
					const ignoredScreenshot = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch", "wait 10"],
						stdin: JSON.stringify([["screenshot", join(tempDir, "sub", "dir", "shot.png")]]),
					});
					assert.equal(ignoredScreenshot.isError, false, JSON.stringify(ignoredScreenshot));
					await assert.rejects(stat(join(tempDir, "sub")), { code: "ENOENT" });

					// The equals form is a raw command upstream, so malformed ignored stdin must
					// not be fatal for it either (state-policy exact --bail parity).
					const bailEqualsMalformed = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["batch", "--bail=true"],
						stdin: "not json",
					});
					assert.equal(bailEqualsMalformed.isError, true, JSON.stringify(bailEqualsMalformed));
					assert.match(readString(bailEqualsMalformed.content[0].text ?? ""), /stdin is ignored/);

					// Upstream-effective raw artifact rows get parent directories prepared.
					const rawScreenshot = await executeRegisteredTool(harness.tool, harness.ctx, {
						// Native batch raw rows use shell-word syntax on every OS: quote
						// backslashes/spaces rather than passing an unquoted Windows path.
						args: [
							"batch",
							`screenshot '${join(tempDir, "raw", "dir", "shot.png").replaceAll("'", "'\\''")}'`,
							"wait 10",
						],
					});
					assert.equal(rawScreenshot.isError, false, JSON.stringify(rawScreenshot));
					assert.equal((await stat(join(tempDir, "raw", "dir"))).isDirectory(), true);
					await assert.rejects(stat(join(tempDir, "sub")), { code: "ENOENT" });
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);
