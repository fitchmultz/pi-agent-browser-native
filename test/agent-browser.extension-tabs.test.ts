/**
 * Purpose: Verify extension integration for presentation artifacts and non-recovery tab targeting behavior.
 * Responsibilities: Assert persisted snapshot spills, batch rendering, click/open enrichment, and routine tab-target state handling.
 * Scope: Integration-style Node test-runner coverage around fake agent-browser executions; process wrapper and resume-state suites cover adjacent concerns.
 * Usage: Run with `npx tsx --test test/agent-browser.extension-tabs.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests run serially where they patch env or secure temp state and do not require a real browser.
 */

import assert from "node:assert/strict";
import { readArray, readNumber, readRecord, readString } from "./helpers/assertions.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionPageState } from "../extensions/agent-browser/lib/session-page-state.js";
import { cleanupSecureTempArtifacts } from "../extensions/agent-browser/lib/temp.js";
import {
	TEST_SESSION_ID,
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./helpers/agent-browser-harness.js";

test(
	"agentBrowserExtension persists compact snapshot spill files for persisted sessions across shutdown cleanup",
	{ concurrency: false },
	async () => {
		await cleanupSecureTempArtifacts();
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-dir-"));
		const sessionFile = join(sessionDir, "session.jsonl");
		const basePath = process.env.PATH ?? "";
		const refs = Object.fromEntries(
			Array.from({ length: 90 }, (_, index) => [
				`e${index + 1}`,
				{
					name: index % 3 === 0 ? `Extension persisted control ${index + 1}` : "",
					role: index % 5 === 0 ? "button" : "generic",
				},
			]),
		);
		const snapshot = Array.from(
			{ length: 120 },
			(_, index) =>
				`- generic "Extension persisted snapshot row ${index + 1}" [ref=e${index + 1}] clickable [onclick]`,
		).join("\n");
		await writeFakeAgentBrowserBinary(
			tempDir,
			`process.stdout.write(JSON.stringify({ success: true, data: ${JSON.stringify({ origin: "https://example.com/persisted-extension", refs, snapshot })} }));`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_PAGE_URL: "https://example.com/persisted-extension",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir, sessionDir, sessionFile });
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const result = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["snapshot", "-i"],
					});
					assert.equal(result.isError, false);
					const spillPath = readString(result.details?.fullOutputPath);
					assert.equal(typeof spillPath, "string");
					assert.equal(
						spillPath.startsWith(join(sessionDir, ".pi-agent-browser-artifacts", TEST_SESSION_ID)),
						true,
					);
					const manifest = readRecord(result.details?.artifactManifest);
					assert.equal(manifest.liveCount, 1);
					assert.equal(readArray(manifest.entries).map(readRecord)[0].path, spillPath);
					assert.equal(readArray(manifest.entries).map(readRecord)[0].retentionState, "live");
					assert.equal(
						readArray(manifest.entries).map(readRecord)[0].storageScope,
						"persistent-session",
					);
					assert.match(readString(result.details?.artifactRetentionSummary), /1 live, 0 evicted/);
					await runExtensionEvent(harness.handlers, "session_shutdown");
					assert.match(await readFile(spillPath, "utf8"), /Extension persisted snapshot row 120/);
				},
			);
		} finally {
			await cleanupSecureTempArtifacts();
			await rm(tempDir, { force: true, recursive: true });
			await rm(sessionDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension restores artifact manifest from branch history and reports later evictions",
	{ concurrency: false },
	async () => {
		await cleanupSecureTempArtifacts();
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-manifest-resume-"));
		const sessionDir = await mkdtemp(join(tmpdir(), "pi-session-manifest-resume-"));
		const sessionFile = join(sessionDir, "session.jsonl");
		const basePath = process.env.PATH ?? "";
		const counterPath = join(tempDir, "counter.txt");
		const refs = Object.fromEntries(
			Array.from({ length: 90 }, (_, index) => [
				`e${index + 1}`,
				{
					name: index % 3 === 0 ? `Resume manifest control ${index + 1}` : "",
					role: index % 5 === 0 ? "button" : "generic",
				},
			]),
		);
		const buildData = (label: string) => ({
			origin: `https://example.com/${label}`,
			refs,
			snapshot: Array.from(
				{ length: 120 },
				(_, index) =>
					`- generic "${label} resume manifest row ${index + 1}" [ref=e${index + 1}] clickable [onclick]`,
			).join("\n"),
		});
		const firstData = buildData("first");
		const secondData = buildData("second");
		const budgetBytes =
			Math.max(
				Buffer.byteLength(JSON.stringify(firstData, null, 2)),
				Buffer.byteLength(JSON.stringify(secondData, null, 2)),
			) + 512;
		await writeFakeAgentBrowserBinary(
			tempDir,
			`
const fs = require("node:fs");
const counterPath = ${JSON.stringify(counterPath)};
if (process.argv.includes("tab") && process.argv.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [{ tabId: "t1", url: "https://example.com/first", active: true }] } }));
  process.exit(0);
}
const count = Number(fs.existsSync(counterPath) ? fs.readFileSync(counterPath, "utf8") : "0") + 1;
fs.writeFileSync(counterPath, String(count));
const data = count === 1 ? ${JSON.stringify(firstData)} : ${JSON.stringify(secondData)};
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_TEST_PAGE_URL: "https://example.com/first",
					PI_AGENT_BROWSER_SESSION_ARTIFACT_MAX_BYTES: String(budgetBytes),
				},
				async () => {
					const firstHarness = createExtensionHarness({ cwd: tempDir, sessionDir, sessionFile });
					await runExtensionEvent(
						firstHarness.handlers,
						"session_start",
						{ reason: "new" },
						firstHarness.ctx,
					);
					const firstResult = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, {
						args: ["snapshot", "-i"],
					});
					assert.equal(firstResult.isError, false);
					const firstPath = readString(firstResult.details?.fullOutputPath);
					assert.equal(typeof firstPath, "string");
					assert.equal(readRecord(firstResult.details?.artifactManifest).liveCount, 1);
					await runExtensionEvent(firstHarness.handlers, "session_shutdown");

					const resumedHarness = createExtensionHarness({
						branch: [...firstHarness.ctx.sessionManager.getBranch()],
						cwd: tempDir,
						sessionDir,
						sessionFile,
					});
					await runExtensionEvent(
						resumedHarness.handlers,
						"session_start",
						{ reason: "resume" },
						resumedHarness.ctx,
					);
					const secondResult = await executeRegisteredTool(
						resumedHarness.tool,
						resumedHarness.ctx,
						{ args: ["snapshot", "-i"] },
					);
					assert.equal(secondResult.isError, false);
					const secondPath = readString(secondResult.details?.fullOutputPath);
					assert.equal(typeof secondPath, "string");
					assert.equal(
						await readFile(firstPath, "utf8").then(
							() => true,
							() => false,
						),
						false,
					);
					assert.match(await readFile(secondPath, "utf8"), /second resume manifest row 120/);
					const manifest = readRecord(secondResult.details?.artifactManifest);
					assert.equal(manifest.liveCount, 1);
					assert.equal(manifest.evictedCount, 1);
					assert.equal(
						readArray(manifest.entries)
							.map(readRecord)
							.some((entry) => entry.path === firstPath && entry.retentionState === "evicted"),
						true,
					);
					assert.equal(
						readArray(manifest.entries)
							.map(readRecord)
							.some((entry) => entry.path === secondPath && entry.retentionState === "live"),
						true,
					);
					assert.match(
						readString(secondResult.details?.artifactRetentionSummary),
						/1 live, 1 evicted/,
					);
				},
			);
		} finally {
			await cleanupSecureTempArtifacts();
			await rm(tempDir, { force: true, recursive: true });
			await rm(sessionDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension preserves rich batch rendering and inline screenshot attachments",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const imagePath = join(tempDir, "batched.png");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`require("node:fs").writeFileSync(${JSON.stringify(imagePath)}, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64"));
process.stdout.write(JSON.stringify([
  { command: ["open", "https://example.com"], success: true, result: { title: "Example Domain", url: "https://example.com/" } },
  { command: ["screenshot"], success: true, result: { path: "batched.png" } }
]));`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: "[]",
				});
				assert.equal(result.isError, false);
				assert.equal(result.content[0]?.type, "text");
				assert.equal(result.content[1]?.type, "image");
				assert.match(readString(readRecord(result.content[0]).text), /Step 2 — screenshot/);
				assert.match(
					readString(readRecord(result.content[0]).text),
					/1 inline image attachment below/,
				);
				assert.equal(readString(result.details?.imagePath).endsWith("batched.png"), true);
				assert.deepEqual(result.details?.imagePaths, [imagePath]);
				assert.equal(Array.isArray(result.details.batchSteps), true);
				assert.equal(readArray(result.details.batchSteps).map(readRecord)[1]?.imagePath, imagePath);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension preserves mixed batch failure rendering while still marking the tool call as an error",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`process.stdout.write(JSON.stringify([
  { command: ["open", "https://example.com"], success: true, result: { title: "Example Domain", url: "https://example.com/" } },
  { command: ["click", "@zzz"], success: false, error: "Unknown ref: zzz" }
]));
process.exitCode = 1;`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: "[]",
				});
				assert.equal(result.isError, true);
				assert.equal(result.content[0]?.type, "text");
				assert.match(
					readString(readRecord(result.content[0]).text),
					/Batch failed: 1\/2 succeeded/,
				);
				assert.match(
					readString(readRecord(result.content[0]).text),
					/First failing step: 2 — click @zzz/,
				);
				assert.match(
					readString(readRecord(result.content[0]).text),
					/Step 1 — open https:\/\/example.com\/? \(succeeded\)/,
				);
				assert.match(readString(readRecord(result.content[0]).text), /Example Domain/);
				assert.match(
					readString(readRecord(result.content[0]).text),
					/Step 2 — click @zzz \(failed\)/,
				);
				assert.match(readString(readRecord(result.content[0]).text), /Error: Unknown ref: zzz/);
				assert.match(readString(readRecord(result.content[0]).text), /snapshot -i/);
				assert.match(readString(readRecord(result.content[0]).text), /find role\|text\|label/);
				assert.match(readString(readRecord(result.content[0]).text), /scrollintoview/);
				assert.equal(
					readString(result.details?.summary).includes("Batch failed: 1/2 succeeded"),
					true,
				);
				assert.equal(readNumber(result.details?.exitCode ?? 0), 1);
				assert.equal(readRecord(readRecord(result.details?.batchFailure).failedStep).index, 1);
				assert.equal(
					readRecord(readRecord(result.details?.batchFailure).failedStep).commandText,
					"click @zzz",
				);
				assert.equal(Array.isArray(result.details?.batchSteps), true);
				assert.equal(readString(result.details?.stderr ?? ""), "");
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension enriches click results with a post-navigation title and url summary",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: true, href: "https://example.com/docs" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Destination Docs" } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://example.com/docs" } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Destination Docs", url: "https://example.com/docs" } } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: {} }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const result = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "named", "click", "@e2"],
				});
				assert.equal(result.isError, false);
				assert.equal(result.content[0]?.type, "text");
				assert.match(readString(readRecord(result.content[0]).text), /Clicked: true/);
				assert.match(
					readString(readRecord(result.content[0]).text),
					/Href: https:\/\/example.com\/docs/,
				);
				assert.match(readString(readRecord(result.content[0]).text), /Current page:/);
				assert.match(readString(readRecord(result.content[0]).text), /Destination Docs/);
				assert.equal(readRecord(result.details?.navigationSummary).title, "Destination Docs");
				assert.equal(readRecord(result.details?.navigationSummary).url, "https://example.com/docs");

				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.length, 5);
				assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "get", "url"]);
				assert.equal(invocations[1]?.args.includes("click"), true);
				assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "get", "url"]);
				assert.deepEqual(invocations[3]?.args, ["--json", "--session", "named", "get", "title"]);
				assert.deepEqual(invocations[4]?.args, ["--json", "--session", "named", "tab", "list"]);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension observes native identity when same-session results omit it",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-no-routine-tab-list-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const clicked = ${JSON.stringify(join(tempDir, "clicked"))};
const url = fs.existsSync(clicked) ? "https://example.com/docs" : "https://example.com/";
if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [{ index: 0, tabId: "t1", targetId: "native-page-1", active: true, title: "Page", url }] } }));
} else if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example Domain", url: "https://example.com/" } }));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "https://example.com/", refs: { e1: { role: "link", name: "Docs" } }, snapshot: '- link "Docs" [ref=e1]' } }));
} else if (args.includes("click")) {
  fs.writeFileSync(clicked, "yes");
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e1" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Docs" } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Docs", url: "https://example.com/docs" } } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: {} }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const open = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://example.com/"],
					sessionMode: "fresh",
				});
				assert.equal(open.isError, false, JSON.stringify(open));
				assert.equal(readRecord(open.details?.sessionTabTarget).targetId, "native-page-1");
				const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
				assert.equal(readRecord(snapshot.details?.sessionTabTarget).targetId, "native-page-1");
				const click = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				assert.equal(click.isError, false, JSON.stringify(click));
				assert.equal(readRecord(click.details?.sessionTabTarget).targetId, "native-page-1");
				assert.equal(
					SessionPageState.fromBranch(harness.ctx.sessionManager.getBranch()).get(
						readString(click.details?.sessionName),
					).tabTarget?.targetId,
					"native-page-1",
				);
				assert.deepEqual(click.details?.navigationSummary, {
					title: "Docs",
					url: "https://example.com/docs",
					urlChanged: true,
				});

				const invocations = await readInvocationLog(logPath);
				const clickIndex = invocations.findIndex((entry) => entry.args.includes("click"));
				assert.ok(clickIndex >= 0);
				assert.ok(
					invocations
						.slice(clickIndex + 1)
						.some((entry) => entry.args.slice(-2).join(" ") === "tab list"),
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension follows a same-address popup after a resumed native batch",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-batch-popup-"));
		const statePath = join(tempDir, "active-tab");
		const logPath = join(tempDir, "invocations.log");
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
let active = fs.existsSync(${JSON.stringify(statePath)}) ? fs.readFileSync(${JSON.stringify(statePath)}, "utf8") : "t1";
const page = { title: "Same Page", url: "https://popup.example/same" };
function run(command) {
  const [name, subcommand] = command;
  if (name === "open") { active = "t1"; return { ...page, targetId: active }; }
  if (name === "click" && subcommand === "#popup") { active = "t2"; return { clicked: true }; }
  if (name === "click") return { clicked: true, savedTab: active };
  if (name === "close") { active = "closed"; return { closed: true }; }
  if (name === "get") return { [subcommand]: page[subcommand] };
  if (name === "tab" && subcommand === "list") return { tabs: ["t1", "t2"].map(id => ({ ...page, tabId: id, targetId: id, active: active === id })) };
  if (name === "tab") { active = subcommand; return { ...page, targetId: active }; }
  if (name === "snapshot") return { origin: page.url, snapshot: '- button "Save ' + active + '" [ref=e1]', refs: { e1: { role: "button", name: "Save " + active } } };
  return {};
}
const command = args.slice(args.indexOf("--session") + 2);
const data = command[0] === "batch"
  ? (command.length > 2 ? command.slice(2).map(row => row.split(" ")) : JSON.parse(stdin)).map(row => ({ command: row, success: true, result: run(row) }))
  : run(command);
fs.writeFileSync(${JSON.stringify(statePath)}, active);
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);
		try {
			await withPatchedEnv({ PATH: `${tempDir}:${process.env.PATH ?? ""}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				const opened = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["--session", "popup", "open", "https://popup.example/same"],
				});
				assert.equal(opened.isError, false, JSON.stringify(opened));
				assert.ok(opened.details);
				const seed = structuredClone(harness.ctx.sessionManager.getBranch());
				for (const mode of ["stdin", "raw", "snapshot", "open-click", "closed"]) {
					// Reset native focus before replaying an independent copy of the real open's journal.
					// oxlint-disable-next-line no-await-in-loop
					await writeFile(statePath, "t1");
					const resumed = createExtensionHarness({
						cwd: tempDir,
						branch: structuredClone(seed),
					});
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					await runExtensionEvent(
						resumed.handlers,
						"session_start",
						{ reason: "resume" },
						resumed.ctx,
					);
					const steps = [
						...(mode === "open-click" ? [["open", "https://popup.example/same"]] : []),
						["click", "#popup"],
						...(mode === "closed" ? [["close"]] : []),
					];
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const popup = await executeRegisteredTool(resumed.tool, resumed.ctx, {
						args: [
							"--session",
							"popup",
							"batch",
							"--bail",
							...(mode === "raw" ? ["click #popup"] : []),
						],
						stdin: JSON.stringify(steps),
					});
					// All five literal popup modes run their lifecycle checks before the next mode.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(popup.isError, false, JSON.stringify(popup));
					if (mode === "closed") {
						// The fixed closed mode checks retired target and no probe, then skips live-page actions.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(popup.details?.sessionTabTarget, undefined);
						// Fixture transitions and their assertions run in order against this test's shared state.
						// oxlint-disable-next-line no-await-in-loop
						const invocations = await readInvocationLog(logPath);
						// The fixed closed mode checks retired target and no probe, then skips live-page actions.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(
							invocations.at(-1)?.args.includes("batch"),
							true,
							"a terminal close must not launch a page probe",
						);
						continue;
					}
					// All five literal popup modes run their lifecycle checks before the next mode.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(readRecord(popup.details?.sessionTabTarget).targetId, "t2", mode);
					if (mode === "snapshot") {
						// Fixture transitions and their assertions run in order against this test's shared state.
						// oxlint-disable-next-line no-await-in-loop
						const snapshot = await executeRegisteredTool(resumed.tool, resumed.ctx, {
							args: ["--session", "popup", "snapshot", "-i"],
						});
						// The fixed snapshot mode additionally checks refs; all live modes still check the saved tab.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
						// The fixed snapshot mode additionally checks refs; all live modes still check the saved tab.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.match(JSON.stringify(snapshot.details?.data), /Save t2/);
						// The fixed snapshot mode additionally checks refs; all live modes still check the saved tab.
						// oxlint-disable-next-line node-test/no-conditional-assertion
						assert.equal(snapshot.details?.sessionTabCorrection, undefined);
					}
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const save = await executeRegisteredTool(resumed.tool, resumed.ctx, {
						args: ["--session", "popup", "click", "#save"],
					});
					// All five literal popup modes run their lifecycle checks before the next mode.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(save.isError, false, JSON.stringify(save));
					// All five literal popup modes run their lifecycle checks before the next mode.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(readRecord(save.details?.data).savedTab, "t2");
					// All five literal popup modes run their lifecycle checks before the next mode.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(save.details?.sessionTabCorrection, undefined);
				}
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension retains deliberate blank tabs for subsequent navigation",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "piab-blank-tab-"));
		const statePath = join(tempDir, "state.json");
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(statePath)};
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { active: "t1", urls: { t1: "about:blank", t2: "about:blank" } };
function page(id = state.active) { return { targetId: id, title: id === "t1" ? "Original" : "", url: state.urls[id] }; }
function run([command, subcommand]) {
  if (command === "open") { state.urls[state.active] = subcommand; return { ...page(), navigatedTab: state.active }; }
  if (command === "tab" && subcommand === "list") return { tabs: ["t1", "t2"].map(id => ({ ...page(id), tabId: id, index: id === "t1" ? 0 : 1, active: id === state.active })) };
  if (command === "tab") { state.active = subcommand === "new" ? "t2" : subcommand; return page(); }
  if (command === "get") return { [subcommand]: page()[subcommand] };
  return {};
}
const command = args.slice(args.indexOf("--session") + 2);
const data = command[0] === "batch" ? JSON.parse(fs.readFileSync(0, "utf8")).map(row => ({ command: row, success: true, result: run(row) })) : run(command);
fs.writeFileSync(statePath, JSON.stringify(state));
process.stdout.write(JSON.stringify({ success: true, data }));`,
		);
		try {
			await withPatchedEnv({ PATH: `${tempDir}:${process.env.PATH ?? ""}` }, async () => {
				for (const selection of [
					["tab", "new"],
					["tab", "t2"],
					["batch", "--bail"],
				]) {
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					await rm(statePath, { force: true });
					const harness = createExtensionHarness({ cwd: tempDir });
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					await runExtensionEvent(
						harness.handlers,
						"session_start",
						{ reason: "new" },
						harness.ctx,
					);
					const call = (args: readonly string[], stdin?: string) =>
						executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["--session", "blank-tab", ...args],
							stdin,
						});
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const initialOpenResult = await call(["open", "https://example.test/original"]);
					// Each of the three literal tab-selection modes checks blank focus and subsequent navigation.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(initialOpenResult.isError, false);
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const selected = await call(
						selection,
						selection[0] === "batch"
							? JSON.stringify([
									["tab", "t2"],
									["get", "url"],
								])
							: undefined,
					);
					// Each of the three literal tab-selection modes checks blank focus and subsequent navigation.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(selected.isError, false);
					// Each of the three literal tab-selection modes checks blank focus and subsequent navigation.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(selected.details?.aboutBlankSessionMismatch, undefined, selection.join(" "));
					// Each of the three literal tab-selection modes checks blank focus and subsequent navigation.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(readRecord(selected.details?.sessionTabTarget).url, "about:blank");
					// Each of the three literal tab-selection modes checks blank focus and subsequent navigation.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(
						// Fixture transitions and their assertions run in order against this test's shared state.
						// oxlint-disable-next-line no-await-in-loop
						readRecord(JSON.parse(await readFile(statePath, "utf8"))).active,
						"t2",
						selection.join(" "),
					);
					// Fixture transitions and their assertions run in order against this test's shared state.
					// oxlint-disable-next-line no-await-in-loop
					const opened = await call(["open", "https://example.test/second"]);
					// Each of the three literal tab-selection modes checks blank focus and subsequent navigation.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(opened.isError, false);
					// Each of the three literal tab-selection modes checks blank focus and subsequent navigation.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(readRecord(opened.details?.data).navigatedTab, "t2");
					// Each of the three literal tab-selection modes checks blank focus and subsequent navigation.
					// oxlint-disable-next-line node-test/no-conditional-assertion
					assert.equal(
						// Fixture transitions and their assertions run in order against this test's shared state.
						// oxlint-disable-next-line no-await-in-loop
						readRecord(readRecord(JSON.parse(await readFile(statePath, "utf8"))).urls).t1,
						"https://example.test/original",
					);
				}
			});
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	},
);

test(
	"agentBrowserExtension refreshes the active tab target after closing a tab",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tab-close-target-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Regression Fixture A", url: "https://fixture.example/" } }));
} else if (args.includes("new")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "React", url: "https://react.dev/" } }));
} else if (args.includes("close")) {
  process.stdout.write(JSON.stringify({ success: true, data: { closed: true, label: "docs" } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://fixture.example/" } }));
} else if (args.includes("get") && args.includes("title")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Regression Fixture A" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: {} }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				assert.equal(
					(
						await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["open", "https://fixture.example/"],
							sessionMode: "fresh",
						})
					).isError,
					false,
				);
				assert.equal(
					(
						await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["tab", "new", "https://react.dev/", "--label", "docs"],
						})
					).isError,
					false,
				);

				const closeTab = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["tab", "close"],
				});
				assert.equal(closeTab.isError, false);
				assert.deepEqual(closeTab.details?.sessionTabTarget, {
					title: "Regression Fixture A",
					url: "https://fixture.example/",
				});
				assert.deepEqual(
					(await readInvocationLog(logPath)).map((entry) => entry.args.slice(-2).join(" ")),
					[
						"open https://fixture.example/",
						"tab list",
						"--label docs",
						"get url",
						"get title",
						"tab list",
						"tab close",
						"get url",
						"get title",
						"tab list",
					],
				);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension live-verifies successful tab selection before later page work",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-tab-selection-"));
		const logPath = join(tempDir, "invocations.log");
		const statePath = join(tempDir, "tab-state");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("tab") && args.includes("t1")) fs.writeFileSync(${JSON.stringify(statePath)}, "selected");
if (args.includes("tab") && args.includes("t2")) fs.writeFileSync(${JSON.stringify(statePath)}, "blank");
if (args.includes("tab") && args.includes("t3")) fs.writeFileSync(${JSON.stringify(statePath)}, "fallback");
if (args.includes("tab") && args.includes("close")) fs.writeFileSync(${JSON.stringify(statePath)}, "blank");
const state = fs.existsSync(${JSON.stringify(statePath)}) ? fs.readFileSync(${JSON.stringify(statePath)}, "utf8") : "start";
const page = state === "blank" ? { title: "", url: "about:blank" } : state === "selected" ? { title: "Selected", url: "https://same.example/" } : state === "fallback" ? { title: "Fallback", url: "https://same.example/" } : { title: "Start", url: "https://same.example/" };
if (args.includes("get") && args.includes("url")) process.stdout.write(JSON.stringify({ success: true, data: { result: page.url, url: page.url } }));
else if (args.includes("get") && args.includes("title")) process.stdout.write(JSON.stringify({ success: true, data: { result: page.title, title: page.title } }));
else if (args.includes("tab") && args.includes("list")) process.stdout.write(JSON.stringify({ success: true, data: { tabs: [{ active: true, id: "t2", title: "", url: "about:blank" }, { active: false, id: "t3", title: "Fallback", url: "https://same.example/" }] } }));
else if (args.includes("tab") && args.includes("close")) process.stdout.write(JSON.stringify({ success: true, data: { closed: true } }));
else if (args.includes("tab") && (args.includes("t1") || args.includes("t2") || args.includes("t3"))) process.stdout.write(JSON.stringify({ success: true, data: { tabId: args.includes("t1") ? "t1" : args.includes("t2") ? "t2" : "t3", ...page } }));
else if (args.includes("set") && args.includes("viewport")) process.stdout.write(JSON.stringify({ success: true, data: { width: 1280, height: 720 } }));
else process.stdout.write(JSON.stringify({ success: true, data: page }));`,
		);
		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);
				assert.equal(
					(
						await executeRegisteredTool(harness.tool, harness.ctx, {
							args: ["open", "https://same.example/"],
						})
					).isError,
					false,
				);
				const selected = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["tab", "t1"],
				});
				assert.equal(selected.isError, false, JSON.stringify(selected));
				assert.equal(selected.details?.sessionTabTargetUnknown, undefined);
				assert.deepEqual(selected.details?.sessionTabTarget, {
					title: "Selected",
					url: "https://same.example/",
				});
				const viewport = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["set", "viewport", "1280", "720"],
				});
				assert.equal(viewport.isError, false, JSON.stringify(viewport));
				const invocations = await readInvocationLog(logPath);
				const tabIndex = invocations.findIndex(
					(entry) => entry.args.includes("tab") && entry.args.includes("t1"),
				);
				const viewportIndex = invocations.findIndex(
					(entry) => entry.args.includes("set") && entry.args.includes("viewport"),
				);
				assert.ok(tabIndex >= 0 && viewportIndex > tabIndex);
				assert.ok(
					invocations
						.slice(tabIndex + 1, viewportIndex)
						.some((entry) => entry.args.includes("get") && entry.args.includes("url")),
				);
				assert.ok(
					invocations
						.slice(tabIndex + 1, viewportIndex)
						.some((entry) => entry.args.includes("get") && entry.args.includes("title")),
				);

				const blank = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["tab", "t2"],
				});
				assert.equal(blank.isError, false, JSON.stringify(blank));
				assert.equal(blank.details?.aboutBlankSessionMismatch, undefined);
				assert.equal(readRecord(blank.details?.sessionTabTarget).url, "about:blank");
				assert.equal(readRecord(blank.details?.sessionTabTarget).title, undefined);
				assert.equal(await readFile(statePath, "utf8"), "blank");

				assert.equal(
					(await executeRegisteredTool(harness.tool, harness.ctx, { args: ["tab", "t1"] })).isError,
					false,
				);
				const closedToBlank = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["tab", "close"],
				});
				assert.equal(closedToBlank.isError, false, JSON.stringify(closedToBlank));
				assert.equal(closedToBlank.details?.aboutBlankSessionMismatch, undefined);
				assert.deepEqual(closedToBlank.details?.sessionTabTarget, {
					title: undefined,
					url: "about:blank",
				});
				assert.equal(await readFile(statePath, "utf8"), "blank");
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test(
	"agentBrowserExtension does not treat arbitrary batch eval title/url results as session navigation",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-batch-eval-target-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("open")) {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example Domain", url: "https://example.com/" } }));
} else if (args.includes("snapshot")) {
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "https://example.com/", refs: { e1: { role: "button", name: "Add" } }, snapshot: '- button "Add" [ref=e1]' } }));
} else if (args.includes("batch")) {
  process.stdout.write(JSON.stringify([
    { command: ["eval", "({ title: document.querySelector('a').textContent, url: document.querySelector('a').href })"], success: true, result: { origin: "https://example.com/", result: { title: "Product details", url: "https://example.com/products/1" } } }
  ]));
} else if (args.includes("click")) {
  process.stdout.write(JSON.stringify({ success: true, data: { clicked: "@e1" } }));
} else if (args.includes("get") && args.includes("url")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: "https://example.com/", url: "https://example.com/" } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: { result: { title: "Example Domain", url: "https://example.com/" } } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: {} }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const harness = createExtensionHarness({ cwd: tempDir });
				await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

				const open = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["open", "https://example.com/"],
					sessionMode: "fresh",
				});
				assert.equal(open.isError, false, JSON.stringify(open));
				const snapshot = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["snapshot", "-i"],
				});
				assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
				const extraction = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["batch"],
					stdin: JSON.stringify([
						[
							"eval",
							"({ title: document.querySelector('a').textContent, url: document.querySelector('a').href })",
						],
					]),
				});
				assert.equal(extraction.isError, false, JSON.stringify(extraction));
				assert.deepEqual(extraction.details?.sessionTabTarget, {
					title: undefined,
					url: "https://example.com/",
				});
				assert.equal(
					(await readInvocationLog(logPath)).some(
						(entry) => entry.args.includes("get") && entry.args.includes("url"),
					),
					true,
				);

				const click = await executeRegisteredTool(harness.tool, harness.ctx, {
					args: ["click", "@e1"],
				});
				assert.equal(click.isError, false, JSON.stringify(click));
				assert.notEqual(click.details?.failureCategory, "stale-ref");
				assert.deepEqual(click.details?.sessionTabTarget, {
					title: undefined,
					url: "https://example.com/",
				});
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);
