/**
 * Purpose: Share validation fixtures whose default-namespace close-all cases need serial execution.
 * Responsibilities: Retain the full namespace-barrier assertions and recording-reservation fixture.
 * Scope: Test-only; named-namespace cases stay parallel, genuinely default-namespace cases run serially.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { readRecord, readString } from "./assertions.js";
import {
	createExtensionHarness,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary,
} from "./agent-browser-harness.js";

export async function runCloseAllNamespaceScenarios(
	t: TestContext,
	scope: "default" | "named",
): Promise<string[]> {
	// Windows ignores fixture socket roots when coordinating native TCP daemons.
	// Named cases therefore need per-invocation namespaces, not just temp directories.
	// Keep the suffix short enough for managed-session Unix sockets on macOS (103 bytes).
	const fixtureId = randomUUID().slice(0, 8);
	const rawNamedNamespace = `Review ${fixtureId}`;
	const namedNamespace = `review-${fixtureId}`;
	const otherScopeNamespace = `other-${fixtureId}`;
	const unrelatedNamespace = `unrelated-${fixtureId}`;
	const scenarios =
		scope === "default"
			? [
					{
						label: "caller-default",
						named: false,
						callerOwned: true,
						override: undefined,
						batch: false,
						ambient: undefined,
						fresh: false,
					},
					{
						label: "explicit-default",
						named: true,
						callerOwned: false,
						override: "",
						batch: false,
						ambient: undefined,
						fresh: false,
					},
					{
						label: "current-default-ambient",
						named: false,
						callerOwned: false,
						override: undefined,
						batch: false,
						ambient: rawNamedNamespace,
						fresh: false,
					},
				]
			: [
					{
						label: "current-named",
						named: true,
						callerOwned: false,
						override: undefined,
						batch: false,
						ambient: undefined,
						fresh: false,
					},
					{
						label: "current-named-batch",
						named: true,
						callerOwned: false,
						override: undefined,
						batch: true,
						ambient: undefined,
						fresh: false,
					},
					{
						label: "explicit-other",
						named: true,
						callerOwned: false,
						override: otherScopeNamespace,
						batch: false,
						ambient: undefined,
						fresh: false,
					},
					{
						label: "fresh-ambient",
						named: true,
						callerOwned: false,
						override: undefined,
						batch: false,
						ambient: rawNamedNamespace,
						fresh: true,
					},
				];
	const completed: string[] = [];
	for (const scenario of scenarios) {
		// Each namespace scenario owns its gates, environment, and shutdown; do not overlap them.
		// oxlint-disable-next-line no-await-in-loop
		await t.test(scenario.label, async () => {
			const openingNamespace = scenario.named ? namedNamespace : "";
			const openingPrefix = scenario.named ? ["--namespace", rawNamedNamespace] : [];
			const openingMode = scenario.callerOwned ? "auto" : "fresh";
			const openingSessionPattern = scenario.callerOwned ? /^pi-root-/ : /^piab-/;
			const namespace = scenario.override ?? openingNamespace;
			const matchingPrefix =
				namespace !== "" || (scenario.ambient !== undefined && scenario.ambient !== "")
					? ["--namespace", namespace]
					: [];
			const closeNamespacePrefix =
				scenario.override !== undefined ? ["--namespace", scenario.override] : [];
			const closeCommand = scenario.batch ? ["batch", "close --all"] : ["close", "--all"];
			const closeMode = scenario.fresh ? "fresh" : "auto";
			const reportedNamespace = scenario.override ?? (namespace === "" ? undefined : namespace);
			const tempDir = await mkdtemp(join(tmpdir(), "piab-close-all-queue-"));
			const cwd = join(tempDir, "g");
			await mkdir(cwd);
			const logPath = join(tempDir, "events.log");
			const openGate = join(tempDir, "release-open");
			const waitGate = join(tempDir, "release-wait");
			const closeGate = join(tempDir, "release-close");
			const nodeBinDir = dirname(process.execPath);
			await writeFakeAgentBrowserBinary(
				tempDir,
				`const fs = require("node:fs");
const args = process.argv.slice(2);
const valueFlags = new Set(["--allow-file-access", "--args", "--namespace", "--session"]);
let commandIndex = -1;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--json") continue;
  if (valueFlags.has(args[index])) { index += 1; continue; }
  if (args[index].startsWith("--")) continue;
  commandIndex = index;
  break;
}
const commandArgs = args.slice(commandIndex);
const command = commandArgs[0];
const namespaceIndex = args.indexOf("--namespace");
const namespace = (namespaceIndex >= 0 ? args[namespaceIndex + 1] : process.env.AGENT_BROWSER_NAMESPACE ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const sessionIndex = args.indexOf("--session");
const sessionName = sessionIndex >= 0 ? args[sessionIndex + 1] : process.env.AGENT_BROWSER_SESSION || "default";
const writeEvent = (event) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, event, namespace, sessionName }) + "\\n");
const waitForGate = (gate) => {
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(gate)) {
    if (Date.now() > deadline) throw new Error("gate was not released: " + gate);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
const closesAll = (command === "close" && commandArgs.includes("--all")) || (command === "batch" && commandArgs.includes("close --all"));
if (closesAll) {
  writeEvent("close-start");
  waitForGate(${JSON.stringify(closeGate)});
  writeEvent("close-end");
} else {
  writeEvent(command + "-start");
  if (command === "open") waitForGate(${JSON.stringify(openGate)});
  if (command === "wait") { waitForGate(${JSON.stringify(waitGate)}); writeEvent("wait-end"); }
}
const data = command === "get" ? { result: "https://safe.example/", url: "https://safe.example/" }
  : command === "tab" ? { tabs: [] } : command === "close" ? { closed: true } : { url: "https://safe.example/" };
process.stdout.write(JSON.stringify(command === "batch"
  ? [{ command: ["close", "--all"], data: { closed: true }, success: true }]
  : { success: true, data }));`,
			);
			const readEvents = async () =>
				(await readInvocationLog(logPath)).map((entry) => ({
					args: entry.args,
					event: readString(entry.event),
					namespace: readString(readRecord(entry).namespace),
					sessionName: readString(entry.sessionName),
				}));
			const waitForEvent = async (event: string) => {
				const deadline = Date.now() + 15_000;
				while (Date.now() <= deadline) {
					// Observe the independently appended event before a deadline-limited retry.
					// oxlint-disable-next-line no-await-in-loop
					const found = (await readEvents()).find((entry) => entry.event === event);
					if (found) {
						return found;
					}
					// Wait between observations rather than overlapping native event reads.
					// oxlint-disable-next-line no-await-in-loop
					await new Promise((resolveDelay) => {
						setTimeout(resolveDelay, 10);
					});
				}
				assert.fail(`${scenario.label}: ${event} did not dispatch`);
			};
			try {
				await withPatchedEnv(
					{
						AGENT_BROWSER_NAMESPACE: scenario.ambient,
						AGENT_BROWSER_SESSION: undefined,
						PATH: `${tempDir}${delimiter}${nodeBinDir}`,
					},
					async () => {
						const harness = createExtensionHarness({
							cwd,
							prompt: "Exercise global close ordering.",
						});
						await runExtensionEvent(
							harness.handlers,
							"session_start",
							{ reason: "new" },
							harness.ctx,
						);
						const pending: Array<ReturnType<typeof executeRegisteredTool>> = [];
						try {
							const open = executeRegisteredTool(harness.tool, harness.ctx, {
								args: [...openingPrefix, "open", "https://safe.example/"],
								sessionMode: openingMode,
							});
							pending.push(open);
							const openStarted = await Promise.race([
								waitForEvent("open-start"),
								open.then((result) =>
									assert.fail(
										`${scenario.label}: open ended before the fixture gate: ${readString(readRecord(result.content.at(0)).text)}`,
									),
								),
							]);
							assert.match(openStarted.sessionName, openingSessionPattern);
							assert.equal(openStarted.namespace, openingNamespace);
							let closeSessionName = openStarted.sessionName;
							if (scenario.callerOwned) {
								closeSessionName = "caller-owned";
							}
							if (scenario.fresh) {
								closeSessionName = "default";
							}
							const wait = executeRegisteredTool(harness.tool, harness.ctx, {
								args: [...matchingPrefix, "--session", "already-running", "wait", "1"],
							});
							pending.push(wait);
							const waitStarted = await waitForEvent("wait-start");
							assert.equal(waitStarted.namespace, namespace);
							const closeAll = executeRegisteredTool(harness.tool, harness.ctx, {
								args: [
									...closeNamespacePrefix,
									...(scenario.fresh ? [] : ["--session", closeSessionName]),
									...closeCommand,
								],
								sessionMode: closeMode,
							});
							pending.push(closeAll);
							await writeFile(openGate, "go");
							const openResult = await open;
							assert.equal(openResult.isError, false, JSON.stringify(openResult));
							assert.equal(readRecord(openResult.details).sessionName, openStarted.sessionName);
							const beforeDrain = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: [
									"--namespace",
									unrelatedNamespace,
									"--session",
									"drain-control",
									"tab",
									"list",
								],
							});
							assert.equal(beforeDrain.isError, false, JSON.stringify(beforeDrain));
							assert.equal(
								(await readEvents()).some((entry) => entry.event === "close-start"),
								false,
								scenario.label,
							);
							await writeFile(waitGate, "go");
							const waitResult = await wait;
							assert.equal(waitResult.isError, false, JSON.stringify(waitResult));
							const closeStarted = await waitForEvent("close-start");
							assert.equal(closeStarted.namespace, namespace, scenario.label);
							assert.equal(closeStarted.sessionName, closeSessionName);
							if (scenario.fresh) {
								// Only the fixed fresh-launch variant emits this replacement close receipt.
								assert.deepEqual(closeStarted.args, ["--json", "close", "--all"]);
							}
							const atCloseStart = (await readEvents()).length;
							const overlappingCaller = executeRegisteredTool(harness.tool, harness.ctx, {
								args: [...matchingPrefix, "--session", "same-namespace", "tab", "list"],
							});
							const overlappingManaged = executeRegisteredTool(harness.tool, harness.ctx, {
								args: ["get", "url"],
							});
							pending.push(overlappingCaller, overlappingManaged);
							const otherNamespace = await executeRegisteredTool(harness.tool, harness.ctx, {
								args: [
									"--namespace",
									unrelatedNamespace,
									"--session",
									"other-session",
									"tab",
									"list",
								],
							});
							assert.equal(otherNamespace.isError, false, JSON.stringify(otherNamespace));
							const whileClosed = (await readEvents()).slice(atCloseStart);
							assert.equal(
								whileClosed.some(
									(entry) =>
										entry.sessionName === "same-namespace" ||
										entry.sessionName.startsWith("piab-") ||
										entry.sessionName.startsWith("pi-root-"),
								),
								false,
								`${scenario.label}: ${JSON.stringify(whileClosed)}`,
							);
							await writeFile(closeGate, "go");
							const [closeResult, callerResult, overlapResult] = await Promise.all([
								closeAll,
								overlappingCaller,
								overlappingManaged,
							]);
							assert.equal(closeResult.isError, false, JSON.stringify(closeResult));
							assert.equal(readRecord(closeResult.details).closeAllApplied, true, scenario.label);
							assert.equal(
								readRecord(closeResult.details).namespace,
								reportedNamespace,
								scenario.label,
							);
							assert.equal(
								readRecord(closeResult.details).sessionName,
								scenario.fresh ? undefined : closeStarted.sessionName,
							);
							assert.equal(callerResult.isError, false, JSON.stringify(callerResult));
							assert.equal(overlapResult.isError, false, JSON.stringify(overlapResult));
							const events = await readEvents();
							const waitEnd = events.findIndex((entry) => entry.event === "wait-end");
							const closeStart = events.findIndex((entry) => entry.event === "close-start");
							const closeEnd = events.findIndex((entry) => entry.event === "close-end");
							const otherStart = events.findIndex(
								(entry) => entry.sessionName === "other-session" && entry.event === "tab-start",
							);
							const lateStart = events.findIndex(
								(entry) => entry.sessionName === "same-namespace" && entry.event === "tab-start",
							);
							const managedStart = events.findIndex(
								(entry) =>
									entry.sessionName === readRecord(overlapResult.details).sessionName &&
									entry.event === "get-start",
							);
							assert.ok(waitEnd >= 0 && closeStart > waitEnd, JSON.stringify(events));
							assert.ok(otherStart > closeStart && otherStart < closeEnd, JSON.stringify(events));
							assert.ok(lateStart > closeEnd && managedStart > closeEnd, JSON.stringify(events));
						} finally {
							await Promise.all(
								[openGate, waitGate, closeGate].map((gate) => writeFile(gate, "go")),
							);
							await Promise.allSettled(pending);
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
				await rm(tempDir, { force: true, recursive: true });
			}
		});
		completed.push(scenario.label);
	}
	return completed;
}

// These PDFs deliberately do not create files: the native receipt proves admission, not artifact success.
export function assertReleasedPdf(result: {
	readonly isError?: boolean;
	readonly details?: Readonly<Record<string, unknown>>;
}): void {
	assert.equal(result.isError, true);
	const details = readRecord(result.details);
	assert.equal(details.failureCategory, "artifact-missing");
	assert.equal(readRecord(details.data).command, "pdf");
}

// Each recording contract gets isolated state, an ffmpeg-free PATH, and a one-row manifest cap.
type RecordingReservationHarnessView = Pick<
	ReturnType<typeof createExtensionHarness>,
	"ctx" | "getTool" | "tool"
> & {
	readonly appendedEntries: readonly Readonly<
		ReturnType<typeof createExtensionHarness>["appendedEntries"][number]
	>[];
	readonly handlers: Parameters<typeof runExtensionEvent>[0];
};

export async function withRecordingReservationHarness(
	slug: string,
	prompt: string,
	run: (
		harness: RecordingReservationHarnessView,
		context: { readonly noRecordingMarker: string; readonly tempDir: string },
	) => Promise<void>,
): Promise<void> {
	const tempDir = await mkdtemp(join(tmpdir(), `pi-agent-browser-recording-${slug}-`));
	const noRecordingMarker = join(tempDir, "no-recording");
	const missingFfmpegPath =
		process.platform === "android" ? join(tempDir, "node-only") : dirname(process.execPath);
	if (process.platform === "android") {
		await mkdir(missingFfmpegPath);
		await symlink(process.execPath, join(missingFfmpegPath, "node"), "file");
	}
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const valueFlags = new Set(["--namespace", "--session"]);
let commandIndex = -1;
for (let i = 0; i < args.length; i += 1) {
  const token = args[i];
  if (token === "--json") continue;
  if (valueFlags.has(token)) { i += 1; continue; }
  if (token.startsWith("--")) continue;
  commandIndex = i;
  break;
}
const commandArgs = args.slice(commandIndex).filter((token) => token !== "--json" && token !== "--quiet");
const command = commandArgs[0];
const subcommand = commandArgs[1];
const path = command === "pdf" ? commandArgs[1] : commandArgs[2];
if (command === "record" && subcommand === "stop" && fs.existsSync(${JSON.stringify(noRecordingMarker)})) {
  process.stdout.write(JSON.stringify({ success: false, error: "No recording in progress" }));
  process.exit(1);
}
if (command === "find") {
  process.stdout.write(JSON.stringify({ success: false, error: "No element found by text 'Missing Control'" }));
  process.exit(1);
}
const batchInput = command === "batch" ? fs.readFileSync(0, "utf8") : "";
const batchSteps = batchInput
  ? JSON.parse(batchInput)
  : commandArgs.slice(1).filter((value) => value !== "--bail" && !value.startsWith("--bail=")).map((value) => value.split(" "));
const closeStepIndex = batchSteps.findIndex((step) => step[0] === "close");
const postCloseStopIndex = batchSteps.findIndex((step, index) => index > closeStepIndex && step[0] === "record" && step[1] === "stop");
const postCloseStopPath = ${JSON.stringify(join(tempDir, "post-close-stop.webm"))};
if (postCloseStopIndex >= 0 && !fs.existsSync(${JSON.stringify(noRecordingMarker)})) fs.writeFileSync(postCloseStopPath, "recording");
const firstCallFailure = command === "batch" && batchSteps.some((step) => step[0] === "click" && step[1] === "#missing-after-close");
const data = command === "batch"
  ? batchSteps.map((step, index) => step[0] === "click" && step[1] === "#missing-after-close"
    ? { command: step, success: false, error: "Element not found after browser launch" }
    : step[0] === "open" && step[1] === "fail-after-close"
      ? { command: step, success: false, error: "Navigation failed after browser launch", result: { lifecycle: { effectiveLaunch: { browserLaunched: true } } } }
    : step[0] === "record" && step[1] === "stop" && fs.existsSync(${JSON.stringify(noRecordingMarker)})
      ? { command: step, success: false, error: "No recording in progress" }
      : { command: step, success: true, result: {
      command: step[0],
      path: index === postCloseStopIndex ? postCloseStopPath : step[2],
      subcommand: step[1],
        ...(index === postCloseStopIndex
          ? { lifecycle: { effectiveLaunch: { browserLaunched: true } } }
          : step[0] === "stream" && step[1] === "status"
            ? { lifecycle: { effectiveLaunch: { browserLaunched: false } } }
            : {}),
      } })
  : command === "get" && subcommand === "url"
    ? { command, subcommand, url: "https://safe.example/" }
    : { command, subcommand, path };
process.stdout.write(JSON.stringify({ success: !firstCallFailure, data }));
if (firstCallFailure) process.exit(1);`,
	);
	try {
		await withPatchedEnv(
			{
				PATH: `${tempDir}${delimiter}${missingFfmpegPath}`,
				PI_AGENT_BROWSER_SESSION_ARTIFACT_MANIFEST_MAX_ENTRIES: "1",
			},
			async () => {
				const harness = createExtensionHarness({
					cwd: tempDir,
					prompt,
					sessionFile: join(tempDir, "session.jsonl"),
				});
				await run(harness, { noRecordingMarker, tempDir });
			},
		);
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
}
