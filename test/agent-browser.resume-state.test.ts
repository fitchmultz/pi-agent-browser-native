/**
 * Purpose: Verify extension resume-state reconstruction and persisted session/tab planning behavior.
 * Responsibilities: Assert managed-session restoration, cwd isolation, fresh-session rotation, explicit-session tab pinning, malformed resumed stdin rejection, stale state protection, and launch-scoped flag blocking after resume.
 * Scope: Integration-style Node test-runner coverage for session resume and stateful command planning.
 * Usage: Run with `npm test -- test/agent-browser.resume-state.test.ts` or via `npm run verify`.
 * Invariants/Assumptions: Tests preserve serial execution where global env or persisted state is patched.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createExtensionHarness,
	createToolBranchEntry,
	executeRegisteredTool,
	readInvocationLog,
	runExtensionEvent,
	withPatchedEnv,
	writeFakeAgentBrowserBinary
} from "./helpers/agent-browser-harness.js";

const CONCURRENCY_TEST_TIMEOUT_MS = 5_000;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withConcurrencyTestTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new Error(message)), CONCURRENCY_TEST_TIMEOUT_MS);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

test("agentBrowserExtension reconstructs managed session state on session_start and keeps startup-scoped flags blocked after resume", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const envelope = args.includes("close")
  ? { success: true, data: { closed: true } }
  : { success: true, data: { url: args[args.length - 1] } };
process.stdout.write(JSON.stringify(envelope));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const firstHarness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(firstHarness.handlers, "session_start", { reason: "new" }, firstHarness.ctx);

			const firstOpen = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, {
				args: ["open", "https://example.com/first"],
			});
			assert.equal(firstOpen.isError, false);
			await runExtensionEvent(firstHarness.handlers, "session_shutdown");
			assert.equal((await readInvocationLog(logPath)).length, 1);

			const resumedBranch = [
				createToolBranchEntry({
					details: firstOpen.details ?? {},
					isError: firstOpen.isError,
				}),
			];
			const resumedHarness = createExtensionHarness({ branch: resumedBranch, cwd: tempDir });
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const blocked = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--profile", "Default", "open", "https://example.com/profiled"],
			});
			assert.equal(blocked.isError, true);
			assert.match(String(blocked.details?.validationError ?? ""), /launch-scoped flags/i);
			assert.equal((await readInvocationLog(logPath)).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension does not restore a managed session from a different cwd/worktree on resume", { concurrency: false }, async () => {
	const firstParent = await mkdtemp(join(tmpdir(), "pi-agent-browser-first-"));
	const secondParent = await mkdtemp(join(tmpdir(), "pi-agent-browser-second-"));
	const firstDir = join(firstParent, "checkout");
	const secondDir = join(secondParent, "checkout");
	const binDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-bin-"));
	const logPath = join(binDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await mkdir(firstDir, { recursive: true });
	await mkdir(secondDir, { recursive: true });
	await writeFakeAgentBrowserBinary(
		binDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { url: args[args.length - 1] } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${binDir}:${basePath}` }, async () => {
			const firstHarness = createExtensionHarness({ cwd: firstDir });
			await runExtensionEvent(firstHarness.handlers, "session_start", { reason: "new" }, firstHarness.ctx);
			const firstOpen = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, {
				args: ["open", "https://example.com/first"],
			});
			assert.equal(firstOpen.isError, false);
			const firstSessionName = firstOpen.details?.sessionName;
			assert.equal(typeof firstSessionName, "string");

			const resumedHarness = createExtensionHarness({
				branch: [createToolBranchEntry({ details: firstOpen.details ?? {}, isError: firstOpen.isError })],
				cwd: secondDir,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const profiledOpen = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--profile", "Default", "open", "https://example.com/profiled"],
			});
			assert.equal(profiledOpen.isError, false);
			assert.equal((profiledOpen.details?.effectiveArgs as string[] | undefined)?.includes("--profile"), true);
			assert.notEqual(profiledOpen.details?.sessionName, firstSessionName);
			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 3);
			assert.equal(invocations[1]?.args.includes("--profile"), true);
			assert.equal(invocations[1]?.args.includes(String(firstSessionName)), false);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", String(profiledOpen.details?.sessionName), "tab", "list"]);
		});
	} finally {
		await rm(firstParent, { force: true, recursive: true });
		await rm(secondParent, { force: true, recursive: true });
		await rm(binDir, { force: true, recursive: true });
	}
});

test(
	"agentBrowserExtension only blocks startup-scoped flags after a successful implicit launch and resets after close",
	{ concurrency: false },
	async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null }) + "\\n");
const envelope = args.includes("close")
  ? { success: true, data: { closed: true } }
  : { success: true, data: { title: "Example Domain", url: args[args.length - 1], idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null } };
process.stdout.write(JSON.stringify(envelope));`,
		);

		try {
			await withPatchedEnv(
				{
					PATH: `${tempDir}:${basePath}`,
					PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS: "1234",
				},
				async () => {
					const harness = createExtensionHarness({ cwd: tempDir });
					await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

					const firstOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["open", "https://example.com"],
					});
					assert.equal(firstOpen.isError, false);
					assert.equal((firstOpen.details?.data as { idleTimeout?: string } | undefined)?.idleTimeout, "1234");

					const afterFirstOpen = await readInvocationLog(logPath);
					assert.equal(afterFirstOpen.length, 1);
					assert.equal(afterFirstOpen[0]?.args.includes("--session"), true);
					assert.equal(afterFirstOpen[0]?.idleTimeout, "1234");

					const blocked = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--profile", "Default", "open", "https://example.com/profile"],
					});
					assert.equal(blocked.isError, true);
					assert.match(String(blocked.details?.validationError ?? ""), /launch-scoped flags/i);
					assert.equal(blocked.details?.sessionMode, "auto");
					assert.equal(
						(blocked.details?.sessionRecoveryHint as { recommendedSessionMode?: string } | undefined)?.recommendedSessionMode,
						"fresh",
					);
					assert.equal((await readInvocationLog(logPath)).length, 1);

					const closeResult = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["close"] });
					assert.equal(closeResult.isError, false);
					assert.equal((await readInvocationLog(logPath)).length, 2);

					const reopened = await executeRegisteredTool(harness.tool, harness.ctx, {
						args: ["--profile", "Default", "open", "https://example.com/profile"],
					});
					assert.equal(reopened.isError, false);

					const finalInvocations = await readInvocationLog(logPath);
					assert.equal(finalInvocations.length, 4);
					assert.equal(finalInvocations[2]?.args.includes("--profile"), true);
					assert.deepEqual(finalInvocations[3]?.args, ["--json", "--session", String(reopened.details?.sessionName), "tab", "list"]);
				},
			);
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	},
);

test("agentBrowserExtension restores the rotated fresh managed session across resume and reuses it on follow-up auto calls", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null }) + "\\n");
const envelope = args.includes("close")
  ? { success: true, data: { closed: true } }
  : { success: true, data: { title: args.includes("--profile") ? "Profiled" : "Public", url: args[args.length - 1], idleTimeout: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS ?? null } };
process.stdout.write(JSON.stringify(envelope));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}`, PI_AGENT_BROWSER_IMPLICIT_SESSION_IDLE_TIMEOUT_MS: "1234" }, async () => {
			const firstHarness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(firstHarness.handlers, "session_start", { reason: "new" }, firstHarness.ctx);

			const firstOpen = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, {
				args: ["open", "https://example.com"],
			});
			assert.equal(firstOpen.isError, false);
			const firstSessionName = firstOpen.details?.sessionName;
			assert.equal(typeof firstSessionName, "string");

			const profiledOpen = await executeRegisteredTool(firstHarness.tool, firstHarness.ctx, {
				args: ["--profile", "Default", "open", "https://example.com/profile"],
				sessionMode: "fresh",
			});
			assert.equal(profiledOpen.isError, false);
			assert.equal(profiledOpen.details?.sessionMode, "fresh");
			assert.equal(profiledOpen.details?.usedImplicitSession, false);
			const freshSessionName = profiledOpen.details?.sessionName;
			assert.equal(typeof freshSessionName, "string");
			assert.notEqual(freshSessionName, firstSessionName);
			assert.equal(
				((profiledOpen.details?.effectiveArgs as string[] | undefined) ?? []).includes(String(freshSessionName)),
				true,
			);
			await runExtensionEvent(firstHarness.handlers, "session_shutdown");

			const resumedHarness = createExtensionHarness({
				branch: [
					createToolBranchEntry({ details: firstOpen.details ?? {}, isError: firstOpen.isError }),
					createToolBranchEntry({ details: profiledOpen.details ?? {}, isError: profiledOpen.isError }),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const followUpSnapshot = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["snapshot", "-i"],
			});
			assert.equal(followUpSnapshot.isError, false);
			assert.equal(followUpSnapshot.details?.sessionName, freshSessionName);
			assert.equal(followUpSnapshot.details?.usedImplicitSession, true);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 6);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", String(firstSessionName), "open", "https://example.com"]);
			assert.equal(invocations[0]?.idleTimeout, "1234");
			assert.deepEqual(invocations[1]?.args, [
				"--json",
				"--session",
				String(freshSessionName),
				"--profile",
				"Default",
				"open",
				"https://example.com/profile",
			]);
			assert.equal(invocations[1]?.idleTimeout, "1234");
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", String(freshSessionName), "tab", "list"]);
			assert.deepEqual(invocations[3]?.args, ["--session", String(firstSessionName), "close"]);
			assert.deepEqual(invocations[4]?.args, ["--json", "--session", String(freshSessionName), "tab", "list"]);
			assert.deepEqual(invocations[5]?.args, ["--json", "--session", String(freshSessionName), "snapshot", "-i"]);
			assert.equal(invocations[5]?.idleTimeout, "1234");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension serializes overlapping base and fresh calls so fresh remains authoritative", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const gatePath = join(tempDir, "release-base");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("https://example.com/slow-base")) {
  while (!fs.existsSync(${JSON.stringify(gatePath)})) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
const envelope = args.includes("close")
  ? { success: true, data: { closed: true } }
  : { success: true, data: { title: args.includes("--profile") ? "Profiled" : "Base", url: args[args.length - 1] } };
process.stdout.write(JSON.stringify(envelope));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const basePromise = executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.com/slow-base"],
			});
			await delay(25);
			const freshPromise = executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--profile", "Default", "open", "https://example.com/fast-fresh"],
				sessionMode: "fresh",
			});
			await delay(25);
			const invocationsBeforeRelease = await readInvocationLog(logPath);
			assert.equal(invocationsBeforeRelease.some((entry) => entry.args.includes("https://example.com/fast-fresh")), false);

			await writeFile(gatePath, "go", "utf8");
			const [baseResult, freshResult] = await withConcurrencyTestTimeout(
				Promise.all([basePromise, freshPromise]),
				"overlapping base/fresh calls did not complete after releasing the base gate",
			);
			assert.equal(baseResult.isError, false, JSON.stringify(baseResult));
			assert.equal(freshResult.isError, false, JSON.stringify(freshResult));

			const freshSessionName = freshResult.details?.sessionName;
			assert.equal(typeof freshSessionName, "string");

			const followUp = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			assert.equal(followUp.isError, false, JSON.stringify(followUp));
			assert.equal(followUp.details?.sessionName, freshSessionName);

			const invocations = await readInvocationLog(logPath);
			assert.equal(
				invocations.some((entry) => entry.args[0] === "--session" && entry.args[1] === String(freshSessionName) && entry.args[2] === "close"),
				false,
			);
			assert.deepEqual(invocations.at(-1)?.args, ["--json", "--session", String(freshSessionName), "snapshot", "-i"]);
		});
	} finally {
		await writeFile(gatePath, "go", "utf8").catch(() => undefined);
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension does not close an overlapping auto call's session mid-command", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const snapshotGatePath = join(tempDir, "release-snapshot");
	const closedDir = join(tempDir, "closed-sessions");
	const basePath = process.env.PATH ?? "";
	await mkdir(closedDir, { recursive: true });
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session");
const sessionName = sessionIndex >= 0 ? args[sessionIndex + 1] : "none";
const closedPath = path.join(${JSON.stringify(closedDir)}, encodeURIComponent(sessionName) + ".closed");
const log = (event) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ event, args, sessionName }) + "\\n");
log("start");
if (args.includes("snapshot")) {
  while (!fs.existsSync(${JSON.stringify(snapshotGatePath)})) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (fs.existsSync(closedPath)) {
    process.stdout.write(JSON.stringify({ success: false, error: "session was closed mid-command" }));
    process.exit(1);
  }
  log("snapshot-done");
}
if (args.includes("close")) {
  fs.writeFileSync(closedPath, "closed");
  log("close-done");
}
const envelope = args.includes("close")
  ? { success: true, data: { closed: true } }
  : { success: true, data: { title: args.includes("--profile") ? "Fresh" : "Base", url: args[args.length - 1] } };
process.stdout.write(JSON.stringify(envelope));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const firstOpen = await executeRegisteredTool(harness.tool, harness.ctx, { args: ["open", "https://example.com/base"] });
			assert.equal(firstOpen.isError, false, JSON.stringify(firstOpen));
			const baseSessionName = firstOpen.details?.sessionName;
			assert.equal(typeof baseSessionName, "string");

			const snapshotPromise = executeRegisteredTool(harness.tool, harness.ctx, { args: ["snapshot", "-i"] });
			await delay(25);
			const freshPromise = executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--profile", "Default", "open", "https://example.com/fresh"],
				sessionMode: "fresh",
			});
			await delay(25);
			const invocationsBeforeRelease = await readInvocationLog(logPath);
			assert.equal(
				invocationsBeforeRelease.some((entry) => entry.event === "close-done" && entry.sessionName === baseSessionName),
				false,
				"fresh rotation must not close the base session while the snapshot is still gated",
			);

			await writeFile(snapshotGatePath, "go", "utf8");
			const [snapshotResult, freshResult] = await withConcurrencyTestTimeout(
				Promise.all([snapshotPromise, freshPromise]),
				"overlapping snapshot/fresh calls did not complete after releasing the snapshot gate",
			);
			assert.equal(snapshotResult.isError, false, JSON.stringify(snapshotResult));
			assert.equal(freshResult.isError, false, JSON.stringify(freshResult));

			const invocations = await readInvocationLog(logPath);
			const snapshotDoneIndex = invocations.findIndex((entry) => entry.event === "snapshot-done" && entry.sessionName === baseSessionName);
			const closeBaseIndex = invocations.findIndex((entry) => entry.event === "close-done" && entry.sessionName === baseSessionName);
			assert.ok(snapshotDoneIndex >= 0, "snapshot should finish against the original managed session");
			assert.ok(closeBaseIndex > snapshotDoneIndex, "base close should happen after the overlapping snapshot finishes");
		});
	} finally {
		await writeFile(snapshotGatePath, "go", "utf8").catch(() => undefined);
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension allocates distinct managed sessions for overlapping fresh launches", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const firstGatePath = join(tempDir, "release-first-fresh");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("https://example.com/fresh-a")) {
  while (!fs.existsSync(${JSON.stringify(firstGatePath)})) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
const envelope = args.includes("close")
  ? { success: true, data: { closed: true } }
  : { success: true, data: { title: "Fresh", url: args[args.length - 1] } };
process.stdout.write(JSON.stringify(envelope));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const firstFreshPromise = executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--profile", "Default", "open", "https://example.com/fresh-a"],
				sessionMode: "fresh",
			});
			await delay(25);
			const secondFreshPromise = executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--profile", "Default", "open", "https://example.com/fresh-b"],
				sessionMode: "fresh",
			});
			await delay(25);
			const invocationsBeforeRelease = await readInvocationLog(logPath);
			assert.equal(invocationsBeforeRelease.some((entry) => entry.args.includes("https://example.com/fresh-b")), false);

			await writeFile(firstGatePath, "go", "utf8");
			const [firstFresh, secondFresh] = await withConcurrencyTestTimeout(
				Promise.all([firstFreshPromise, secondFreshPromise]),
				"overlapping fresh calls did not complete after releasing the first fresh gate",
			);
			assert.equal(firstFresh.isError, false, JSON.stringify(firstFresh));
			assert.equal(secondFresh.isError, false, JSON.stringify(secondFresh));
			assert.equal(typeof firstFresh.details?.sessionName, "string");
			assert.equal(typeof secondFresh.details?.sessionName, "string");
			assert.notEqual(firstFresh.details?.sessionName, secondFresh.details?.sessionName);

			const firstSessionName = String(firstFresh.details?.sessionName);
			const secondSessionName = String(secondFresh.details?.sessionName);
			const invocations = await readInvocationLog(logPath);
			assert.ok(invocations.some((entry) => entry.args.includes(firstSessionName) && entry.args.includes("https://example.com/fresh-a")));
			assert.ok(invocations.some((entry) => entry.args.includes(secondSessionName) && entry.args.includes("https://example.com/fresh-b")));
		});
	} finally {
		await writeFile(firstGatePath, "go", "utf8").catch(() => undefined);
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension restores pinned tab targets across resume for explicit sessions", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const exampleSite = { title: "Example Domain", url: "https://example.com/" };
const gemini = { title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en" };
if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  let active = gemini;
  const results = steps.map((step) => {
    const [command, ...rest] = step;
    if (command === "tab") {
      active = rest[0] === "t1" ? exampleSite : gemini;
      return { command: step, success: true, result: active };
    }
    if (command === "snapshot") {
      return {
        command: step,
        success: true,
        result: {
          origin: active.url,
          refs: { e1: { name: active.title, role: "heading" } },
          snapshot: '- heading "' + active.title + '" [level=1, ref=e1]',
        },
      };
    }
    return { command: step, success: true, result: active };
  });
  process.stdout.write(JSON.stringify(results));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: exampleSite.title, url: exampleSite.url, active: false },
    { tabId: "t2", title: gemini.title, url: gemini.url, active: true }
  ] } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: {
    origin: gemini.url,
    refs: { e1: { name: gemini.title, role: "heading" } },
    snapshot: '- heading "Google Gemini" [level=1, ref=e1]'
  } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const resumedHarness = createExtensionHarness({
				branch: [
					createToolBranchEntry({
						details: {
							args: ["--session", "named", "--profile", "Default", "open", "https://example.com"],
							command: "open",
							sessionName: "named",
							sessionTabTarget: { title: "Example Domain", url: "https://example.com/" },
						},
						isError: false,
					}),
				],
				cwd: tempDir,
			});
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const snapshot = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "snapshot", "-i"],
			});
			assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
			assert.deepEqual(snapshot.details?.sessionTabCorrection, {
				selectedTab: "t1",
				selectionKind: "tabId",
				targetTitle: "Example Domain",
				targetUrl: "https://example.com/",
			});
			assert.match((snapshot.content[0] as { text: string }).text, /Example Domain/);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 2);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "batch"]);
			assert.deepEqual(JSON.parse(String(invocations[1]?.stdin ?? "[]")), [["tab", "t1"], ["snapshot", "-i"]]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension pre-pins resumed explicit-session snapshot when about:blank is active", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-blank-pin-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const exampleSite = { title: "Example Domain", url: "https://example.com/" };
if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  const results = steps.map((step) => {
    const [command, selectedTab] = step;
    if (command === "tab") return { command: step, success: true, result: { tabId: selectedTab, ...exampleSite } };
    if (command === "snapshot") return { command: step, success: true, result: { origin: exampleSite.url, refs: { e1: { name: exampleSite.title, role: "heading" } }, snapshot: '- heading "Example Domain" [level=1, ref=e1]' } };
    return { command: step, success: true, result: exampleSite };
  });
  process.stdout.write(JSON.stringify(results));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "blank", title: "", url: "about:blank", active: true },
    { tabId: "t1", title: exampleSite.title, url: exampleSite.url, active: false }
  ] } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { origin: "about:blank", snapshot: "Origin: about:blank" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const resumedHarness = createExtensionHarness({
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
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const snapshot = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "snapshot", "-i"],
			});
			assert.equal(snapshot.isError, false, JSON.stringify(snapshot));
			assert.deepEqual(snapshot.details?.sessionTabCorrection, {
				selectedTab: "t1",
				selectionKind: "tabId",
				targetTitle: "Example Domain",
				targetUrl: "https://example.com/",
			});
			assert.match((snapshot.content[0] as { text: string }).text, /Example Domain/);
			assert.doesNotMatch((snapshot.content[0] as { text: string }).text, /Origin: about:blank/);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 2);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "batch"]);
			assert.deepEqual(JSON.parse(String(invocations[1]?.stdin ?? "[]")), [["tab", "t1"], ["snapshot", "-i"]]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension pre-pins resumed explicit-session eval stdin before execution", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const statePath = join(tempDir, "tab-state.json");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const exampleSite = { title: "Example Domain", url: "https://example.com/" };
const gemini = { title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en" };
let state = { active: "gemini" };
try { state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, "utf8")); } catch {}
const activeSite = () => state.active === "example" ? exampleSite : gemini;
const save = () => fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: exampleSite.title, url: exampleSite.url, active: state.active === "example" },
    { tabId: "t2", title: gemini.title, url: gemini.url, active: state.active !== "example" }
  ] } }));
} else if (args.includes("tab") && args.includes("t1")) {
  state.active = "example";
  save();
  process.stdout.write(JSON.stringify({ success: true, data: { tabId: "t1", ...exampleSite } }));
} else if (args.includes("eval")) {
  process.stdout.write(JSON.stringify({ success: true, data: activeSite().title }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: activeSite() }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const resumedHarness = createExtensionHarness({
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
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const evalResult = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "eval", "--stdin"],
				stdin: "document.title",
			});
			assert.equal(evalResult.isError, false, JSON.stringify(evalResult));
			assert.match((evalResult.content[0] as { text: string }).text, /Example Domain/);
			assert.deepEqual(evalResult.details?.sessionTabTarget, {
				title: "Example Domain",
				url: "https://example.com/",
			});

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 3);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "tab", "t1"]);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", "named", "eval", "--stdin"]);
			assert.equal(invocations[2]?.stdin, "document.title");
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects unsupported stdin before resumed explicit-session tab planning", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { title: "Wrong", url: "https://wrong.example/" } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const resumedHarness = createExtensionHarness({
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
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const result = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "click", "@e9"],
				stdin: "oops",
			});

			assert.equal(result.isError, true, JSON.stringify(result));
			assert.match(String(result.details?.validationError ?? ""), /stdin/i);
			assert.match(String(result.details?.validationError ?? ""), /batch/i);
			assert.match(String(result.details?.validationError ?? ""), /eval --stdin/i);
			assert.match(String((result.content[0] as { text: string }).text ?? ""), /stdin/i);
			assert.equal(result.details?.sessionName, "named");

			const invocations = await readInvocationLog(logPath);
			assert.deepEqual(invocations, []);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension pre-pins resumed explicit-session user batch and derives the resulting target", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
const sites = {
  example: { title: "Example Domain", url: "https://example.com/" },
  gemini: { title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en" },
  org: { title: "Example Org", url: "https://example.org/" }
};
if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  let active = sites.gemini;
  const results = steps.map((step) => {
    const [command, ...rest] = step;
    if (command === "tab") {
      active = rest[0] === "t1" ? sites.example : sites.gemini;
      return { command: step, success: true, result: { tabId: rest[0], ...active } };
    }
    if (command === "open") {
      active = sites.org;
      return { command: step, success: true, result: active };
    }
    if (command === "get" && rest[0] === "title") {
      return { command: step, success: true, result: active.title };
    }
    if (command === "get" && rest[0] === "url") {
      return { command: step, success: true, result: active.url };
    }
    return { command: step, success: true, result: active };
  });
  process.stdout.write(JSON.stringify(results));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: sites.example.title, url: sites.example.url, active: false },
    { tabId: "t2", title: sites.gemini.title, url: sites.gemini.url, active: true }
  ] } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: sites.gemini }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const resumedHarness = createExtensionHarness({
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
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const batchResult = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "batch"],
				stdin: JSON.stringify([["open", "https://example.org"], ["get", "title"], ["get", "url"]]),
			});
			assert.equal(batchResult.isError, false, JSON.stringify(batchResult));
			assert.match((batchResult.content[0] as { text: string }).text, /Example Org/);
			assert.deepEqual(batchResult.details?.sessionTabTarget, {
				title: "Example Org",
				url: "https://example.org/",
			});
			const batchSteps = batchResult.details?.batchSteps as Array<{ command?: string[] }> | undefined;
			assert.deepEqual(batchSteps?.map((step) => step.command), [
				["open", "https://example.org/"],
				["get", "title"],
				["get", "url"],
			]);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 2);
			assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "tab", "list"]);
			assert.deepEqual(invocations[1]?.args, ["--json", "--session", "named", "batch"]);
			assert.deepEqual(JSON.parse(String(invocations[1]?.stdin ?? "[]")), [
				["tab", "t1"],
				["open", "https://example.org"],
				["get", "title"],
				["get", "url"],
			]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension rejects malformed resumed explicit-session batch stdin before user batch execution", { concurrency: false }, async () => {
	const scenarios = [
		{
			name: "invalid JSON",
			stdin: "not-json",
			errorPattern: /could not be parsed as JSON/i,
		},
		{
			name: "non-array step",
			stdin: JSON.stringify([{ oops: 1 }]),
			errorPattern: /step 0 must be a non-empty array of string command tokens/i,
		},
		{
			name: "empty step",
			stdin: JSON.stringify([[]]),
			errorPattern: /step 0 must not be empty/i,
		},
		{
			name: "non-string token",
			stdin: JSON.stringify([["click", 123]]),
			errorPattern: /step 0 token 1 must be a string/i,
		},
	] as const;

	for (const scenario of scenarios) {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
		const logPath = join(tempDir, "invocations.log");
		const basePath = process.env.PATH ?? "";
		await writeFakeAgentBrowserBinary(
			tempDir,
			`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args.includes("batch")) {
  process.stdout.write(JSON.stringify({ success: true, data: [{ command: ["batch"], success: true, result: "should not run" }] }));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: "Example Domain", url: "https://example.com/", active: false },
    { tabId: "t2", title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en", active: true }
  ] } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Unexpected", url: "https://unexpected.example/" } }));
}`,
		);

		try {
			await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
				const resumedHarness = createExtensionHarness({
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
				await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

				const batchResult = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
					args: ["--session", "named", "batch"],
					stdin: scenario.stdin,
				});
				assert.equal(batchResult.isError, true, `${scenario.name}: ${JSON.stringify(batchResult)}`);
				assert.match(String(batchResult.details?.validationError ?? ""), scenario.errorPattern, scenario.name);

				const invocations = await readInvocationLog(logPath);
				assert.equal(invocations.length, 1, scenario.name);
				assert.deepEqual(invocations[0]?.args, ["--json", "--session", "named", "tab", "list"], scenario.name);
			});
		} finally {
			await rm(tempDir, { force: true, recursive: true });
		}
	}
});

test("agentBrowserExtension does not combine stale batch title with a later url after intervening commands", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, stdin }) + "\\n");
let active = { title: "Google Gemini", url: "https://gemini.google.com/glic?hl=en" };
const example = { title: "Example Domain", url: "https://example.com/" };
const org = { title: "Example Org", url: "https://example.org/" };
if (args.includes("batch")) {
  const steps = JSON.parse(stdin || "[]");
  const results = steps.map((step) => {
    const [command, ...rest] = step;
    if (command === "tab") {
      active = rest[0] === "t1" ? example : active;
      return { command: step, success: true, result: { tabId: rest[0], ...active } };
    }
    if (command === "get" && rest[0] === "title") {
      return { command: step, success: true, result: active.title };
    }
    if (command === "open") {
      active = org;
      return { command: step, success: true, result: { status: "navigated" } };
    }
    if (command === "get" && rest[0] === "url") {
      return { command: step, success: true, result: active.url };
    }
    return { command: step, success: true, result: { status: "ok" } };
  });
  process.stdout.write(JSON.stringify(results));
} else if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: example.title, url: example.url, active: false },
    { tabId: "t2", title: active.title, url: active.url, active: true }
  ] } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: active }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const resumedHarness = createExtensionHarness({
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
			await runExtensionEvent(resumedHarness.handlers, "session_start", { reason: "resume" }, resumedHarness.ctx);

			const batchResult = await executeRegisteredTool(resumedHarness.tool, resumedHarness.ctx, {
				args: ["--session", "named", "batch"],
				stdin: JSON.stringify([["get", "title"], ["open", "https://example.org"], ["get", "url"]]),
			});
			assert.equal(batchResult.isError, false, JSON.stringify(batchResult));
			assert.deepEqual(batchResult.details?.sessionTabTarget, { title: undefined, url: "https://example.org/" });

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 2);
			assert.deepEqual(JSON.parse(String(invocations[1]?.stdin ?? "[]")), [
				["tab", "t1"],
				["get", "title"],
				["open", "https://example.org"],
				["get", "url"],
			]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension does not mark a failed first implicit command as active", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const shouldFail = args.includes("https://fail.example");
process.stdout.write(JSON.stringify(shouldFail ? { success: false, error: "intentional failure" } : { success: true, data: { title: "Recovered" } }));
process.exit(shouldFail ? 1 : 0);`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const failedOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://fail.example"],
			});
			assert.equal(failedOpen.isError, true);
			assert.equal((await readInvocationLog(logPath)).length, 1);

			const followUp = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--profile", "Default", "open", "https://example.com/recovered"],
			});
			assert.equal(followUp.isError, false);
			assert.equal(followUp.details?.validationError, undefined);
			assert.equal((followUp.details?.effectiveArgs as string[] | undefined)?.includes("--profile"), true);

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 3);
			assert.equal(invocations[1]?.args.includes("--profile"), true);
			assert.deepEqual(invocations[2]?.args, ["--json", "--session", String(followUp.details?.sessionName), "tab", "list"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension blocks launch-scoped --state and --auto-connect flags after an implicit session is active", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
process.stdout.write(JSON.stringify({ success: true, data: { title: "Example Domain", url: args[args.length - 1] } }));`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const firstOpen = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["open", "https://example.com"],
			});
			assert.equal(firstOpen.isError, false);

			for (const args of [
				["--state", "/tmp/auth.json", "open", "https://example.com/state"],
				["--auto-connect", "open", "https://example.com/auto"],
			] as const) {
				const blocked = await executeRegisteredTool(harness.tool, harness.ctx, { args: [...args] });
				assert.equal(blocked.isError, true, `expected ${args[0]} to be blocked`);
				assert.match(String(blocked.details?.validationError ?? ""), /launch-scoped flags/i);
				assert.equal(blocked.details?.sessionMode, "auto");
				assert.equal(
					(blocked.details?.sessionRecoveryHint as { recommendedSessionMode?: string } | undefined)?.recommendedSessionMode,
					"fresh",
				);
			}

			assert.equal((await readInvocationLog(logPath)).length, 1);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});

test("agentBrowserExtension re-selects the navigated tab after --session-name fresh opens when restored tabs steal focus", { concurrency: false }, async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-test-"));
	const logPath = join(tempDir, "invocations.log");
	const basePath = process.env.PATH ?? "";
	await writeFakeAgentBrowserBinary(
		tempDir,
		`const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
if (args.includes("tab") && args.includes("list")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabs: [
    { tabId: "t1", title: "Example Domain", url: "https://example.com/", active: false },
    { tabId: "t2", title: "Restored Tab", url: "https://restored.example.com/", active: true }
  ] } }));
} else if (args.includes("tab") && args.includes("t1")) {
  process.stdout.write(JSON.stringify({ success: true, data: { tabId: "t1", title: "Example Domain", url: "https://example.com/" } }));
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { title: "Example Domain", url: "https://example.com/" } }));
}`,
	);

	try {
		await withPatchedEnv({ PATH: `${tempDir}:${basePath}` }, async () => {
			const harness = createExtensionHarness({ cwd: tempDir });
			await runExtensionEvent(harness.handlers, "session_start", { reason: "new" }, harness.ctx);

			const result = await executeRegisteredTool(harness.tool, harness.ctx, {
				args: ["--session-name", "saved-auth", "open", "https://example.com"],
				sessionMode: "fresh",
			});
			assert.equal(result.isError, false);
			assert.deepEqual(result.details?.openResultTabCorrection, {
				selectedTab: "t1",
				selectionKind: "tabId",
				targetTitle: "Example Domain",
				targetUrl: "https://example.com/",
			});

			const invocations = await readInvocationLog(logPath);
			assert.equal(invocations.length, 3);
			assert.equal(invocations[0]?.args.includes("--session-name"), true);
			assert.deepEqual(invocations[1]?.args?.slice(-2), ["tab", "list"]);
			assert.deepEqual(invocations[2]?.args?.slice(-2), ["tab", "t1"]);
		});
	} finally {
		await rm(tempDir, { force: true, recursive: true });
	}
});
